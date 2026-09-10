/**
 * IncidentService — gerenciamento de incidentes sistêmicos do Motor v2.
 *
 * Responsabilidades:
 * - Criar ou atualizar incidentes identificados por assinatura determinística
 *   (classe da falha + serviço afetado + mensagem normalizada).
 * - Registrar janela temporal (abertura e última atualização) do incidente.
 * - Preservar diagnóstico consolidado e lista de tarefas impactadas.
 * - Evitar agrupamento indevido: assinaturas diferentes geram incidentes distintos.
 *
 * A assinatura é determinística para que falhas recorrentes do mesmo tipo
 * (ex.: Console indisponível, SSH unreachable) sejam agrupadas em um único
 * incidente, em vez de cada tarefa afetada gerar um incidente independente.
 */

import { createLogger } from "../shared/logger.js"
import type { Db } from "../shared/types/infrastructure.js"

const logger = createLogger("IncidentService")

// ─── Tipos públicos ─────────────────────────────────────────────────────────

/** Classe da falha — categorias conhecidas de bloqueio de infraestrutura. */
export type IncidentFailureClass =
  | "git_repository_missing"
  | "git_repository_corrupted"
  | "worktree_missing"
  | "branch_diverged"
  | "commit_lost"
  | "dependencies_missing"
  | "dependencies_inconsistent"
  | "project_scope_violation"
  | "console_unreachable"
  | "ssh_deploy_unreachable"
  | "multiple_infrastructure_failures"
  | "session_failure"
  | "unknown"

/** Serviço afetado — componente de infraestrutura que causou a falha. */
export type IncidentAffectedService =
  | "git"
  | "worktree"
  | "dependencies"
  | "console"
  | "ssh_deploy"
  | "gateway"
  | "multiple"
  | "unknown"

/** Dados para criar ou atualizar um incidente. */
export interface IncidentInput {
  /** Classe da falha (ex.: console_unreachable). */
  failureClass: IncidentFailureClass
  /** Serviço afetado (ex.: console). */
  affectedService: IncidentAffectedService
  /** Mensagem original da falha (será normalizada para a assinatura). */
  rawMessage: string
  /** ID da tarefa impactada. */
  taskId: string
  /** ID da subtarefa impactada (se aplicável). */
  subtaskId?: number | null
  /** Diagnóstico consolidado (texto livre com detalhes do preflight). */
  diagnosis?: string
  /** Janela de agrupamento em milissegundos. Default: 1 hora. */
  windowMs?: number
}

/** Incidente persistido. */
export interface IncidentRecord {
  id: string
  signature: string
  failureClass: string
  affectedService: string
  normalizedMessage: string
  diagnosis: string
  taskIds: string[]
  subtaskIds: number[]
  openedAt: string
  updatedAt: string
  resolvedAt: string | null
  occurrenceCount: number
}

/** Resultado da operação de upsert. */
export interface IncidentUpsertResult {
  /** Incidente criado ou atualizado. */
  incident: IncidentRecord
  /** Se foi criado (true) ou atualizado (false). */
  created: boolean
  /** Assinatura determinística usada. */
  signature: string
}

// ─── Normalização de mensagem ───────────────────────────────────────────────

/**
 * Normaliza uma mensagem de falha para compor a assinatura determinística.
 * Remove detalhes voláteis (SHAs, números de porta, timestamps, caminhos)
 * para que falhas do mesmo tipo produzam a mesma assinatura.
 */
export function normalizeFailureMessage(raw: string): string {
  return raw
    .toLowerCase()
    // Remove UUIDs PRIMEIRO (antes de SHAs, pois UUIDs contêm hex que SHAs pegariam)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    // Remove timestamps ISO (antes de números, pois timestamps contêm números)
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[.\d]*z?/g, "<ts>")
    // Remove caminhos absolutos (antes de números, pois caminhos contêm números)
    .replace(/\/[a-z0-9_./-]+/g, "<path>")
    // Remove SHAs (7-40 hex chars)
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    // Remove números de porta (após : ou "porta")
    .replace(/:\d{2,5}\b/g, ":<port>")
    .replace(/porta\s+\d+/g, "porta <n>")
    // Remove números isolados (IDs, contadores)
    .replace(/\b\d+\b/g, "<n>")
    // Normaliza espaços
    .replace(/\s+/g, " ")
    .trim()
    // Limita tamanho para evitar assinaturas gigantes
    .slice(0, 300)
}

/**
 * Gera a assinatura determinística de um incidente.
 * Composição: classe da falha + serviço afetado + mensagem normalizada.
 */
export function computeIncidentSignature(
  failureClass: IncidentFailureClass,
  affectedService: IncidentAffectedService,
  rawMessage: string,
): string {
  const normalized = normalizeFailureMessage(rawMessage)
  return `${failureClass}:${affectedService}:${normalized}`
}

// ─── Mapeamento: classificação do preflight → classe/serviço ────────────────

/**
 * Mapeia a classificação do ResumePreflightChecker para as categorias
 * do IncidentService (failureClass + affectedService).
 */
export function mapPreflightClassification(classification: string): {
  failureClass: IncidentFailureClass
  affectedService: IncidentAffectedService
} {
  switch (classification) {
    case "git_repository_missing":
      return { failureClass: "git_repository_missing", affectedService: "git" }
    case "git_repository_corrupted":
      return { failureClass: "git_repository_corrupted", affectedService: "git" }
    case "worktree_missing":
      return { failureClass: "worktree_missing", affectedService: "worktree" }
    case "branch_diverged":
      return { failureClass: "branch_diverged", affectedService: "worktree" }
    case "commit_lost":
      return { failureClass: "commit_lost", affectedService: "git" }
    case "dependencies_missing":
      return { failureClass: "dependencies_missing", affectedService: "dependencies" }
    case "dependencies_inconsistent":
      return { failureClass: "dependencies_inconsistent", affectedService: "dependencies" }
    case "project_scope_violation":
      return { failureClass: "project_scope_violation", affectedService: "worktree" }
    case "console_unreachable":
      return { failureClass: "console_unreachable", affectedService: "console" }
    case "ssh_deploy_unreachable":
      return { failureClass: "ssh_deploy_unreachable", affectedService: "ssh_deploy" }
    case "multiple_infrastructure_failures":
      return { failureClass: "multiple_infrastructure_failures", affectedService: "multiple" }
    default:
      return { failureClass: "unknown", affectedService: "unknown" }
  }
}

// ─── IncidentService ────────────────────────────────────────────────────────

/** Janela de agrupamento padrão: 1 hora. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000

export class IncidentService {
  private readonly db: Db
  private readonly defaultWindowMs: number

  constructor(db: Db, options?: { defaultWindowMs?: number }) {
    this.db = db
    this.defaultWindowMs = options?.defaultWindowMs ?? DEFAULT_WINDOW_MS
  }

  /**
   * Cria ou atualiza um incidente baseado na assinatura determinística.
   *
   * Se já existe um incidente aberto com a mesma assinatura dentro da janela,
   * a tarefa é adicionada à lista de impactadas e o diagnóstico é atualizado.
   * Se não existe, um novo incidente é criado.
   *
   * NÃO agrupa falhas de assinatura diferente — cada assinatura distinta
   * gera um incidente separado.
   */
  async upsertIncident(input: IncidentInput): Promise<IncidentUpsertResult> {
    const windowMs = input.windowMs ?? this.defaultWindowMs
    const signature = computeIncidentSignature(
      input.failureClass,
      input.affectedService,
      input.rawMessage,
    )
    const normalizedMessage = normalizeFailureMessage(input.rawMessage)
    const now = new Date().toISOString()
    const windowStart = new Date(Date.now() - windowMs).toISOString()

    // Busca incidente aberto com a mesma assinatura dentro da janela
    const { rows: existingRows } = await this.db.query(
      `SELECT id, signature, failure_class, affected_service, normalized_message,
              diagnosis, task_ids, subtask_ids, opened_at, updated_at, resolved_at,
              occurrence_count
       FROM motor_incidents
       WHERE signature = ?
         AND resolved_at IS NULL
         AND updated_at >= ?
       LIMIT 1`,
      [signature, windowStart],
    )

    if (existingRows.length > 0) {
      // Atualizar incidente existente — adicionar tarefa e atualizar diagnóstico
      const existing = existingRows[0]!
      const existingTaskIds = parseJsonArray(existing.task_ids)
      const existingSubtaskIds = parseJsonNumberArray(existing.subtask_ids)

      // Adiciona a nova tarefa se ainda não está na lista
      if (!existingTaskIds.includes(input.taskId)) {
        existingTaskIds.push(input.taskId)
      }
      if (input.subtaskId && !existingSubtaskIds.includes(input.subtaskId)) {
        existingSubtaskIds.push(input.subtaskId)
      }

      // Atualiza diagnóstico com a nova ocorrência
      const updatedDiagnosis = appendDiagnosis(
        String(existing.diagnosis ?? ""),
        input.diagnosis ?? input.rawMessage,
        input.taskId,
        now,
      )

      const newCount = Number(existing.occurrence_count ?? 1) + 1

      await this.db.query(
        `UPDATE motor_incidents
         SET diagnosis = ?, task_ids = ?, subtask_ids = ?, updated_at = ?,
             occurrence_count = ?
         WHERE id = ?`,
        [
          updatedDiagnosis,
          JSON.stringify(existingTaskIds),
          JSON.stringify(existingSubtaskIds),
          now,
          newCount,
          existing.id,
        ],
      )

      logger.info("Incidente atualizado", {
        incidentId: existing.id,
        signature: signature.slice(0, 80),
        taskId: input.taskId,
        occurrenceCount: newCount,
      })

      return {
        incident: {
          id: String(existing.id),
          signature: String(existing.signature),
          failureClass: String(existing.failure_class),
          affectedService: String(existing.affected_service),
          normalizedMessage: String(existing.normalized_message),
          diagnosis: updatedDiagnosis,
          taskIds: existingTaskIds,
          subtaskIds: existingSubtaskIds,
          openedAt: String(existing.opened_at),
          updatedAt: now,
          resolvedAt: existing.resolved_at ? String(existing.resolved_at) : null,
          occurrenceCount: newCount,
        },
        created: false,
        signature,
      }
    }

    // Criar novo incidente
    const incidentId = generateIncidentId()
    const taskIds = [input.taskId]
    const subtaskIds = input.subtaskId ? [input.subtaskId] : []
    const diagnosis = input.diagnosis ?? input.rawMessage

    await this.db.query(
      `INSERT INTO motor_incidents
       (id, signature, failure_class, affected_service, normalized_message,
        diagnosis, task_ids, subtask_ids, opened_at, updated_at, resolved_at,
        occurrence_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      [
        incidentId,
        signature,
        input.failureClass,
        input.affectedService,
        normalizedMessage,
        diagnosis,
        JSON.stringify(taskIds),
        JSON.stringify(subtaskIds),
        now,
        now,
      ],
    )

    logger.info("Incidente criado", {
      incidentId,
      signature: signature.slice(0, 80),
      taskId: input.taskId,
      failureClass: input.failureClass,
      affectedService: input.affectedService,
    })

    return {
      incident: {
        id: incidentId,
        signature,
        failureClass: input.failureClass,
        affectedService: input.affectedService,
        normalizedMessage,
        diagnosis,
        taskIds,
        subtaskIds,
        openedAt: now,
        updatedAt: now,
        resolvedAt: null,
        occurrenceCount: 1,
      },
      created: true,
      signature,
    }
  }

  /**
   * Resolve um incidente (marca como resolvido).
   * Usado quando o preflight passa com sucesso após uma recuperação.
   */
  async resolveIncident(incidentId: string): Promise<void> {
    const now = new Date().toISOString()
    await this.db.query(
      "UPDATE motor_incidents SET resolved_at = ?, updated_at = ? WHERE id = ?",
      [now, now, incidentId],
    )
    logger.info("Incidente resolvido", { incidentId })
  }

  /**
   * Busca um incidente pela assinatura.
   * Retorna null se não houver incidente aberto com essa assinatura.
   */
  async findBySignature(signature: string): Promise<IncidentRecord | null> {
    const { rows } = await this.db.query(
      `SELECT id, signature, failure_class, affected_service, normalized_message,
              diagnosis, task_ids, subtask_ids, opened_at, updated_at, resolved_at,
              occurrence_count
       FROM motor_incidents
       WHERE signature = ? AND resolved_at IS NULL
       LIMIT 1`,
      [signature],
    )
    if (rows.length === 0) return null
    const row = rows[0]!
    return {
      id: String(row.id),
      signature: String(row.signature),
      failureClass: String(row.failure_class),
      affectedService: String(row.affected_service),
      normalizedMessage: String(row.normalized_message),
      diagnosis: String(row.diagnosis ?? ""),
      taskIds: parseJsonArray(row.task_ids),
      subtaskIds: parseJsonNumberArray(row.subtask_ids),
      openedAt: String(row.opened_at),
      updatedAt: String(row.updated_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      occurrenceCount: Number(row.occurrence_count ?? 1),
    }
  }

  /**
   * Lista incidentes abertos (não resolvidos).
   */
  async listOpenIncidents(): Promise<IncidentRecord[]> {
    const { rows } = await this.db.query(
      `SELECT id, signature, failure_class, affected_service, normalized_message,
              diagnosis, task_ids, subtask_ids, opened_at, updated_at, resolved_at,
              occurrence_count
       FROM motor_incidents
       WHERE resolved_at IS NULL
       ORDER BY updated_at DESC`,
    )
    return rows.map((row) => ({
      id: String(row.id),
      signature: String(row.signature),
      failureClass: String(row.failure_class),
      affectedService: String(row.affected_service),
      normalizedMessage: String(row.normalized_message),
      diagnosis: String(row.diagnosis ?? ""),
      taskIds: parseJsonArray(row.task_ids),
      subtaskIds: parseJsonNumberArray(row.subtask_ids),
      openedAt: String(row.opened_at),
      updatedAt: String(row.updated_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      occurrenceCount: Number(row.occurrence_count ?? 1),
    }))
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String)
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseJsonNumberArray(value: unknown): number[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(Number).filter((n) => !isNaN(n))
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => !isNaN(n)) : []
  } catch {
    return []
  }
}

function appendDiagnosis(
  existing: string,
  newEntry: string,
  taskId: string,
  timestamp: string,
): string {
  const entry = `[${timestamp}] tarefa=${taskId}: ${newEntry}`
  if (!existing) return entry
  // Limita o tamanho do diagnóstico consolidado para não crescer indefinidamente
  const combined = existing + "\n" + entry
  if (combined.length > 5000) {
    return combined.slice(combined.length - 5000)
  }
  return combined
}

function generateIncidentId(): string {
  // Formato: inc-<timestamp>-<random>
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `inc-${ts}-${rand}`
}
