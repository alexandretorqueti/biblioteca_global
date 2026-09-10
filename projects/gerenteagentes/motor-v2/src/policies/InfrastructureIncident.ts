/**
 * InfrastructureIncident — agrupamento determinístico de falhas sistêmicas.
 *
 * Responsabilidades:
 * - Computar assinatura determinística de incidente a partir de:
 *   classe da falha, serviço afetado e mensagem normalizada
 * - Gerenciar criação/atualização de incidentes na tabela
 *   `motor_infrastructure_incidents` (janela temporal + tarefas associadas)
 * - Garantir que falhas com a mesma assinatura compartilhem o mesmo
 *   incident_id, enquanto assinaturas distintas NÃO são agrupadas
 *
 * A assinatura é um hash SHA-256 truncado dos componentes normalizados,
 * garantindo determinismo independente de ordem ou detalhes voláteis.
 */

import { createHash } from "node:crypto"
import type { Db } from "../shared/types/infrastructure.js"
import { createLogger } from "../shared/logger.js"

const logger = createLogger("InfrastructureIncident")

// ─── Tipos públicos ─────────────────────────────────────────────────────────

/** Classe da falha de infraestrutura (derivada do IncidentClassification). */
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
  | "unknown"

/** Serviço afetado pela falha. */
export type IncidentAffectedService =
  | "git"
  | "worktree"
  | "dependencies"
  | "console"
  | "ssh_deploy"
  | "project_scope"
  | "multiple"
  | "unknown"

/** Componentes para computar a assinatura determinística. */
export interface IncidentSignatureComponents {
  failureClass: IncidentFailureClass
  affectedService: IncidentAffectedService
  normalizedMessage: string
}

/** Resultado da resolução de incidente (criar ou atualizar). */
export interface ResolvedIncident {
  incidentId: string
  signature: string
  createdAt: string
  updatedAt: string
  firstSeenAt: string
  lastSeenAt: string
  affectedTaskIds: number[]
}

// ─── Mapeamento: classificação → serviço afetado ────────────────────────────

/**
 * Deriva o serviço afetado a partir da classificação da falha.
 * Mapeamento determinístico e exaustivo.
 */
export function affectedServiceFromClassification(
  failureClass: IncidentFailureClass,
): IncidentAffectedService {
  switch (failureClass) {
    case "git_repository_missing":
    case "git_repository_corrupted":
      return "git"
    case "worktree_missing":
    case "branch_diverged":
    case "commit_lost":
      return "worktree"
    case "dependencies_missing":
    case "dependencies_inconsistent":
      return "dependencies"
    case "console_unreachable":
      return "console"
    case "ssh_deploy_unreachable":
      return "ssh_deploy"
    case "project_scope_violation":
      return "project_scope"
    case "multiple_infrastructure_failures":
      return "multiple"
    default:
      return "unknown"
  }
}

// ─── Normalização de mensagem ────────────────────────────────────────────────

/**
 * Normaliza uma mensagem de falha para uso na assinatura determinística.
 * Remove detalhes voláteis (SHAs, números, caminhos absolutos, timestamps)
 * e reduz a mensagem ao padrão estrutural da falha.
 *
 * A ordem das substituições importa: UUIDs, IPs e timestamps devem ser
 * removidos antes de números isolados para evitar fragmentação.
 */
export function normalizeIncidentMessage(rawMessage: string): string {
  return rawMessage
    // Remove timestamps ISO (antes de números, pois contém dígitos)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<timestamp>")
    // Remove UUIDs (antes de números, pois contém dígitos e hex)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    // Remove IPs (antes de números, pois contém dígitos separados por pontos)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "<addr>")
    // Remove user@host patterns (antes de números, pois o host pode conter IPs)
    .replace(/\b\w+@[\w.-]+/g, "<target>")
    // Remove SHAs (7-40 hex chars)
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
    // Remove caminhos absolutos (Unix)
    .replace(/\/[a-zA-Z0-9_./-]+/g, "<path>")
    // Remove números isolados (portas, IDs, contagens)
    .replace(/\b\d+\b/g, "<n>")
    // Normaliza espaços
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

// ─── Computação de assinatura ────────────────────────────────────────────────

/**
 * Computa a assinatura determinística de um incidente.
 * A assinatura é um hash SHA-256 truncado (40 chars) dos componentes
 * normalizados, garantindo que:
 * - Mesmos componentes → mesma assinatura (determinística)
 * - Componentes diferentes → assinaturas diferentes (colisão improvável)
 */
export function computeIncidentSignature(
  components: IncidentSignatureComponents,
): string {
  const canonical = [
    `class:${components.failureClass}`,
    `service:${components.affectedService}`,
    `message:${components.normalizedMessage}`,
  ].join("|")

  return createHash("sha256")
    .update(canonical, "utf-8")
    .digest("hex")
    .slice(0, 40)
}

/**
 * Constrói os componentes de assinatura a partir de uma classificação
 * de falha do preflight e da mensagem original do bloqueio.
 */
export function buildSignatureComponents(
  failureClass: IncidentFailureClass,
  rawMessage: string,
): IncidentSignatureComponents {
  return {
    failureClass,
    affectedService: affectedServiceFromClassification(failureClass),
    normalizedMessage: normalizeIncidentMessage(rawMessage),
  }
}

// ─── Gerenciador de Incidentes ───────────────────────────────────────────────

/**
 * Gerencia o ciclo de vida de incidentes de infraestrutura no banco.
 *
 * - resolveOrCreate: dado uma assinatura, retorna o incident_id existente
 *   (se dentro da janela de 7 dias) ou cria um novo incidente
 * - addTaskToIncident: associa uma tarefa a um incidente existente
 * - getIncident: retorna os detalhes de um incidente (janela, tarefas)
 */
export class InfrastructureIncidentManager {
  private readonly db: Db
  /** Janela temporal para reutilização de incidente (ms). Default: 7 dias. */
  private readonly incidentWindowMs: number

  constructor(options: { db: Db; incidentWindowMs?: number }) {
    this.db = options.db
    this.incidentWindowMs = options.incidentWindowMs ?? 7 * 24 * 60 * 60 * 1000
  }

  /**
   * Resolve ou cria um incidente para a assinatura fornecida.
   * Se existe um incidente ativo (dentro da janela) com a mesma assinatura,
   * reutiliza o incident_id. Caso contrário, cria um novo.
   *
   * A janela temporal é registrada como first_seen_at/last_seen_at.
   */
  async resolveOrCreate(
    signature: string,
    failureClass: IncidentFailureClass,
    affectedService: IncidentAffectedService,
    normalizedMessage: string,
  ): Promise<string> {
    // Busca incidente existente com a mesma assinatura dentro da janela
    const windowSeconds = Math.floor(this.incidentWindowMs / 1000)
    const { rows } = await this.db.query(
      "SELECT incident_id FROM motor_infrastructure_incidents " +
      "WHERE signature = ? AND last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) " +
      "ORDER BY last_seen_at DESC LIMIT 1",
      [signature, windowSeconds],
    )

    if (rows.length > 0 && rows[0]?.incident_id) {
      const existingId = String(rows[0].incident_id)
      // Atualiza last_seen_at do incidente existente
      await this.db.query(
        "UPDATE motor_infrastructure_incidents SET last_seen_at = NOW(), updated_at = NOW() WHERE incident_id = ?",
        [existingId],
      )
      logger.info("Incidente reutilizado: " + existingId + " (signature=" + signature.slice(0, 12) + "…)")
      return existingId
    }

    // Cria novo incidente
    const incidentId = "incident-" + signature.slice(0, 16) + "-" + Date.now().toString(36)
    await this.db.query(
      "INSERT INTO motor_infrastructure_incidents " +
      "(incident_id, signature, failure_class, affected_service, normalized_message, first_seen_at, last_seen_at) " +
      "VALUES (?, ?, ?, ?, ?, NOW(), NOW())",
      [incidentId, signature, failureClass, affectedService, normalizedMessage],
    )
    logger.info("Novo incidente criado: " + incidentId + " (class=" + failureClass + ", service=" + affectedService + ")")
    return incidentId
  }

  /**
   * Associa uma tarefa a um incidente existente.
   * Idempotente: se a tarefa já está associada, não duplica.
   */
  async addTaskToIncident(incidentId: string, tarefaId: number): Promise<void> {
    // Verifica se já existe associação
    const { rows: existing } = await this.db.query(
      "SELECT id FROM motor_infrastructure_incident_tasks WHERE incident_id = ? AND tarefa_id = ?",
      [incidentId, tarefaId],
    )
    if (existing.length > 0) return

    await this.db.query(
      "INSERT INTO motor_infrastructure_incident_tasks (incident_id, tarefa_id, associated_at) VALUES (?, ?, NOW())",
      [incidentId, tarefaId],
    )
  }

  /**
   * Retorna os detalhes de um incidente, incluindo janela temporal
   * e lista de tarefas associadas.
   */
  async getIncident(incidentId: string): Promise<ResolvedIncident | null> {
    const { rows: incidentRows } = await this.db.query(
      "SELECT incident_id, signature, failure_class, affected_service, normalized_message, " +
      "first_seen_at, last_seen_at, created_at, updated_at " +
      "FROM motor_infrastructure_incidents WHERE incident_id = ? LIMIT 1",
      [incidentId],
    )
    if (incidentRows.length === 0) return null

    const incident = incidentRows[0] as Record<string, unknown>

    const { rows: taskRows } = await this.db.query(
      "SELECT tarefa_id FROM motor_infrastructure_incident_tasks WHERE incident_id = ? ORDER BY associated_at",
      [incidentId],
    )

    return {
      incidentId: String(incident.incident_id),
      signature: String(incident.signature),
      createdAt: String(incident.created_at),
      updatedAt: String(incident.updated_at),
      firstSeenAt: String(incident.first_seen_at),
      lastSeenAt: String(incident.last_seen_at),
      affectedTaskIds: taskRows.map((row) => Number((row as Record<string, unknown>).tarefa_id)),
    }
  }

  /**
   * Lista incidentes ativos (últimos N dias), ordenados por mais recente.
   */
  async listActiveIncidents(days = 7): Promise<Array<{
    incidentId: string
    failureClass: string
    affectedService: string
    normalizedMessage: string
    firstSeenAt: string
    lastSeenAt: string
    taskCount: number
  }>> {
    const { rows } = await this.db.query(
      "SELECT i.incident_id, i.failure_class, i.affected_service, i.normalized_message, " +
      "i.first_seen_at, i.last_seen_at, COUNT(t.id) AS task_count " +
      "FROM motor_infrastructure_incidents i " +
      "LEFT JOIN motor_infrastructure_incident_tasks t ON t.incident_id = i.incident_id " +
      "WHERE i.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? DAY) " +
      "GROUP BY i.incident_id " +
      "ORDER BY i.last_seen_at DESC",
      [days],
    )
    return rows.map((row) => {
      const data = row as Record<string, unknown>
      return {
        incidentId: String(data.incident_id),
        failureClass: String(data.failure_class),
        affectedService: String(data.affected_service),
        normalizedMessage: String(data.normalized_message),
        firstSeenAt: String(data.first_seen_at),
        lastSeenAt: String(data.last_seen_at),
        taskCount: Number(data.task_count),
      }
    })
  }
}
