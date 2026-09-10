/**
 * Testes do IncidentService
 * @vitest-environment node
 *
 * Testa:
 * - Assinatura determinística (classe + serviço + mensagem normalizada)
 * - Criação de incidente novo
 * - Atualização de incidente existente (mesma assinatura)
 * - Falhas de assinatura diferente NÃO são agrupadas
 * - Janela temporal respeitada
 * - Lista de tarefas impactadas preservada
 * - Normalização de mensagem remove detalhes voláteis
 */

import { describe, expect, it, beforeEach } from "vitest"
import {
  IncidentService,
  normalizeFailureMessage,
  computeIncidentSignature,
  mapPreflightClassification,
  type IncidentFailureClass,
  type IncidentAffectedService,
} from "../src/policies/IncidentService.js"

// ─── Mock de banco de dados ─────────────────────────────────────────────────

interface MockIncidentRow {
  id: string
  signature: string
  failure_class: string
  affected_service: string
  normalized_message: string
  diagnosis: string
  task_ids: string
  subtask_ids: string
  opened_at: string
  updated_at: string
  resolved_at: string | null
  occurrence_count: number
}

function createMockDb() {
  const incidents: MockIncidentRow[] = []

  return {
    _incidents: incidents,
    query: async (sql: string, params?: unknown[]) => {
      const sqlLower = sql.toLowerCase().trim()

      // SELECT para buscar incidente existente
      if (sqlLower.includes("select") && sqlLower.includes("from motor_incidents") && sqlLower.includes("where signature")) {
        const signature = String(params?.[0] ?? "")
        const windowStart = params?.[1] ? String(params[1]) : ""
        const matched = incidents.filter((inc) => {
          if (inc.signature !== signature) return false
          if (inc.resolved_at !== null) return false
          if (windowStart && inc.updated_at < windowStart) return false
          return true
        })
        return { rows: matched.slice(0, 1), affectedRows: 0, insertId: 0 }
      }

      // SELECT para listOpenIncidents
      if (sqlLower.includes("select") && sqlLower.includes("from motor_incidents") && sqlLower.includes("resolved_at is null") && !sqlLower.includes("signature")) {
        const matched = incidents.filter((inc) => inc.resolved_at === null)
        return { rows: matched, affectedRows: 0, insertId: 0 }
      }

      // INSERT
      if (sqlLower.includes("insert into motor_incidents")) {
        const row: MockIncidentRow = {
          id: String(params?.[0]),
          signature: String(params?.[1]),
          failure_class: String(params?.[2]),
          affected_service: String(params?.[3]),
          normalized_message: String(params?.[4]),
          diagnosis: String(params?.[5]),
          task_ids: String(params?.[6]),
          subtask_ids: String(params?.[7]),
          opened_at: String(params?.[8]),
          updated_at: String(params?.[9]),
          resolved_at: null,
          occurrence_count: 1,
        }
        incidents.push(row)
        return { rows: [], affectedRows: 1, insertId: 0 }
      }

      // UPDATE para atualizar incidente existente
      if (sqlLower.includes("update motor_incidents") && sqlLower.includes("diagnosis")) {
        const diagnosis = String(params?.[0])
        const taskIds = String(params?.[1])
        const subtaskIds = String(params?.[2])
        const updatedAt = String(params?.[3])
        const occurrenceCount = Number(params?.[4])
        const id = String(params?.[5])
        const idx = incidents.findIndex((inc) => inc.id === id)
        if (idx >= 0) {
          incidents[idx] = {
            ...incidents[idx]!,
            diagnosis,
            task_ids: taskIds,
            subtask_ids: subtaskIds,
            updated_at: updatedAt,
            occurrence_count: occurrenceCount,
          }
        }
        return { rows: [], affectedRows: idx >= 0 ? 1 : 0, insertId: 0 }
      }

      // UPDATE para resolver incidente
      if (sqlLower.includes("update motor_incidents") && sqlLower.includes("resolved_at")) {
        const resolvedAt = String(params?.[0])
        const updatedAt = String(params?.[1])
        const id = String(params?.[2])
        const idx = incidents.findIndex((inc) => inc.id === id)
        if (idx >= 0) {
          incidents[idx] = {
            ...incidents[idx]!,
            resolved_at: resolvedAt,
            updated_at: updatedAt,
          }
        }
        return { rows: [], affectedRows: idx >= 0 ? 1 : 0, insertId: 0 }
      }

      return { rows: [], affectedRows: 0, insertId: 0 }
    },
    transaction: async <T>(fn: (db: any) => Promise<T>) => fn({ query: async () => ({ rows: [], affectedRows: 0, insertId: 0 }) }),
  }
}

// ─── Normalização de mensagem ───────────────────────────────────────────────

describe("normalizeFailureMessage", () => {
  it("remove SHAs de commit", () => {
    expect(normalizeFailureMessage("Falha no commit abc1234def5678"))
      .toBe("falha no commit <sha>")
  })

  it("remove números de porta", () => {
    expect(normalizeFailureMessage("Porta 3001 ocupada"))
      .toBe("porta <n> ocupada")
  })

  it("remove caminhos absolutos", () => {
    expect(normalizeFailureMessage("Arquivo /data/workspace/repo/package.json não encontrado"))
      .toBe("arquivo <path> não encontrado")
  })

  it("remove timestamps ISO", () => {
    expect(normalizeFailureMessage("Timeout em 2026-09-10T12:00:00.000Z"))
      .toBe("timeout em <ts>")
  })

  it("remove UUIDs", () => {
    expect(normalizeFailureMessage("Sessão 550e8400-e29b-41d4-a716-446655440000 expirada"))
      .toBe("sessão <uuid> expirada")
  })

  it("normaliza espaços múltiplos", () => {
    expect(normalizeFailureMessage("falha   com   espaços   múltiplos"))
      .toBe("falha com espaços múltiplos")
  })

  it("limita tamanho a 300 caracteres", () => {
    const longMessage = "x".repeat(500)
    expect(normalizeFailureMessage(longMessage).length).toBeLessThanOrEqual(300)
  })

  it("produz a mesma assinatura para mensagens com detalhes voláteis diferentes", () => {
    const msg1 = "Console indisponível em http://127.0.0.1:6280 — ECONNREFUSED"
    const msg2 = "Console indisponível em http://127.0.0.1:6281 — ECONNREFUSED"
    // As portas são normalizadas, então a assinatura deve ser a mesma
    expect(normalizeFailureMessage(msg1)).toBe(normalizeFailureMessage(msg2))
  })
})

// ─── Assinatura determinística ──────────────────────────────────────────────

describe("computeIncidentSignature", () => {
  it("compõe classe + serviço + mensagem normalizada", () => {
    const sig = computeIncidentSignature("console_unreachable", "console", "Console não respondeu")
    expect(sig).toBe("console_unreachable:console:console não respondeu")
  })

  it("assinaturas diferentes para classes diferentes", () => {
    const sig1 = computeIncidentSignature("console_unreachable", "console", "timeout")
    const sig2 = computeIncidentSignature("ssh_deploy_unreachable", "ssh_deploy", "timeout")
    expect(sig1).not.toBe(sig2)
  })

  it("assinaturas diferentes para serviços diferentes", () => {
    const sig1 = computeIncidentSignature("unknown", "console", "falha")
    const sig2 = computeIncidentSignature("unknown", "ssh_deploy", "falha")
    expect(sig1).not.toBe(sig2)
  })

  it("mesma assinatura para mesma falha com detalhes voláteis diferentes", () => {
    const sig1 = computeIncidentSignature("dependencies_missing", "dependencies", "node_modules ausente em /data/workspace/abc")
    const sig2 = computeIncidentSignature("dependencies_missing", "dependencies", "node_modules ausente em /data/workspace/xyz")
    expect(sig1).toBe(sig2)
  })
})

// ─── Mapeamento de classificação do preflight ──────────────────────────────

describe("mapPreflightClassification", () => {
  it("mapeia console_unreachable corretamente", () => {
    const result = mapPreflightClassification("console_unreachable")
    expect(result.failureClass).toBe("console_unreachable")
    expect(result.affectedService).toBe("console")
  })

  it("mapeia ssh_deploy_unreachable corretamente", () => {
    const result = mapPreflightClassification("ssh_deploy_unreachable")
    expect(result.failureClass).toBe("ssh_deploy_unreachable")
    expect(result.affectedService).toBe("ssh_deploy")
  })

  it("mapeia git_repository_missing corretamente", () => {
    const result = mapPreflightClassification("git_repository_missing")
    expect(result.failureClass).toBe("git_repository_missing")
    expect(result.affectedService).toBe("git")
  })

  it("mapeia multiple_infrastructure_failures corretamente", () => {
    const result = mapPreflightClassification("multiple_infrastructure_failures")
    expect(result.failureClass).toBe("multiple_infrastructure_failures")
    expect(result.affectedService).toBe("multiple")
  })

  it("mapeia classificação desconhecida para unknown", () => {
    const result = mapPreflightClassification("something_new")
    expect(result.failureClass).toBe("unknown")
    expect(result.affectedService).toBe("unknown")
  })
})

// ─── IncidentService — criação e atualização ────────────────────────────────

describe("IncidentService — criação de incidente", () => {
  it("cria incidente novo quando não existe incidente com a mesma assinatura", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    const result = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu em http://127.0.0.1:6280",
      taskId: "task-1",
      subtaskId: 10,
    })

    expect(result.created).toBe(true)
    expect(result.incident.taskIds).toEqual(["task-1"])
    expect(result.incident.subtaskIds).toEqual([10])
    expect(result.incident.occurrenceCount).toBe(1)
    expect(result.incident.resolvedAt).toBeNull()
    expect(result.signature).toContain("console_unreachable:console:")
  })

  it("atribui ID único ao incidente criado", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    const result = await service.upsertIncident({
      failureClass: "ssh_deploy_unreachable",
      affectedService: "ssh_deploy",
      rawMessage: "SSH connection refused",
      taskId: "task-2",
    })

    expect(result.incident.id).toMatch(/^inc-/)
  })
})

describe("IncidentService — atualização de incidente existente", () => {
  it("atualiza incidente existente quando a assinatura é a mesma", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    // Cria primeiro incidente
    const first = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
      subtaskId: 10,
    })
    expect(first.created).toBe(true)

    // Cria segundo incidente com a mesma assinatura
    const second = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-2",
      subtaskId: 20,
    })

    expect(second.created).toBe(false)
    expect(second.incident.id).toBe(first.incident.id)
    expect(second.incident.taskIds).toContain("task-1")
    expect(second.incident.taskIds).toContain("task-2")
    expect(second.incident.subtaskIds).toContain(10)
    expect(second.incident.subtaskIds).toContain(20)
    expect(second.incident.occurrenceCount).toBe(2)
  })

  it("NÃO agrupa falhas de assinatura diferente", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    // Console unreachable
    const consoleIncident = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
    })

    // SSH unreachable (assinatura diferente)
    const sshIncident = await service.upsertIncident({
      failureClass: "ssh_deploy_unreachable",
      affectedService: "ssh_deploy",
      rawMessage: "SSH connection refused",
      taskId: "task-2",
    })

    expect(consoleIncident.incident.id).not.toBe(sshIncident.incident.id)
    expect(db._incidents.length).toBe(2)
  })

  it("NÃO agrupa falhas da mesma classe mas com mensagens diferentes", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    const incident1 = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console timeout após 10s",
      taskId: "task-1",
    })

    const incident2 = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console retornou 503 Service Unavailable",
      taskId: "task-2",
    })

    // Mensagens diferentes → assinaturas diferentes → incidentes diferentes
    expect(incident1.incident.id).not.toBe(incident2.incident.id)
    expect(db._incidents.length).toBe(2)
  })
})

// ─── IncidentService — janela temporal ──────────────────────────────────────

describe("IncidentService — janela temporal", () => {
  it("cria novo incidente quando o anterior está fora da janela", async () => {
    const db = createMockDb()
    // Janela de 1ms para facilitar o teste
    const service = new IncidentService(db as any, { defaultWindowMs: 1 })

    const first = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
    })
    expect(first.created).toBe(true)

    // Aguarda a janela expirar
    await new Promise((resolve) => setTimeout(resolve, 10))

    const second = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-2",
    })

    // Fora da janela → novo incidente
    expect(second.created).toBe(true)
    expect(second.incident.id).not.toBe(first.incident.id)
    expect(db._incidents.length).toBe(2)
  })
})

// ─── IncidentService — resolução ────────────────────────────────────────────

describe("IncidentService — resolução", () => {
  it("resolve incidente e não o lista mais como aberto", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    const result = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
    })

    await service.resolveIncident(result.incident.id)

    const openIncidents = await service.listOpenIncidents()
    expect(openIncidents.length).toBe(0)
  })

  it("incidente resolvido permite criar novo com a mesma assinatura", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    const first = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
    })

    await service.resolveIncident(first.incident.id)

    const second = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-2",
    })

    expect(second.created).toBe(true)
    expect(second.incident.id).not.toBe(first.incident.id)
  })
})

// ─── IncidentService — diagnóstico consolidado ──────────────────────────────

describe("IncidentService — diagnóstico consolidado", () => {
  it("preserva diagnóstico de todas as ocorrências", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-1",
      diagnosis: "Primeira ocorrência: Console caiu",
    })

    const result = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console não respondeu",
      taskId: "task-2",
      diagnosis: "Segunda ocorrência: Console ainda fora",
    })

    // O diagnóstico inicial é preservado e a nova ocorrência é anexada
    expect(result.incident.diagnosis).toContain("Primeira ocorrência")
    expect(result.incident.diagnosis).toContain("task-2")
    expect(result.incident.diagnosis).toContain("Segunda ocorrência")
  })

  it("lista de tarefas impactadas cresce com novas ocorrências", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    await service.upsertIncident({
      failureClass: "ssh_deploy_unreachable",
      affectedService: "ssh_deploy",
      rawMessage: "SSH refused",
      taskId: "task-a",
    })

    await service.upsertIncident({
      failureClass: "ssh_deploy_unreachable",
      affectedService: "ssh_deploy",
      rawMessage: "SSH refused",
      taskId: "task-b",
    })

    const result = await service.upsertIncident({
      failureClass: "ssh_deploy_unreachable",
      affectedService: "ssh_deploy",
      rawMessage: "SSH refused",
      taskId: "task-c",
    })

    expect(result.incident.taskIds).toEqual(["task-a", "task-b", "task-c"])
    expect(result.incident.occurrenceCount).toBe(3)
  })

  it("não duplica tarefa já registrada no incidente", async () => {
    const db = createMockDb()
    const service = new IncidentService(db as any)

    await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console down",
      taskId: "task-1",
    })

    const result = await service.upsertIncident({
      failureClass: "console_unreachable",
      affectedService: "console",
      rawMessage: "Console down",
      taskId: "task-1", // mesma tarefa
    })

    expect(result.incident.taskIds).toEqual(["task-1"])
    expect(result.incident.occurrenceCount).toBe(2) // conta a ocorrência mas não duplica task
  })
})
