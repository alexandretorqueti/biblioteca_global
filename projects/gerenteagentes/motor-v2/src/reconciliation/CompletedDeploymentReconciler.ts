import type { Db } from "../shared/types/infrastructure.js"

export interface CompletedDeploymentReconciliationCandidate {
  tarefaId: string | number
  externalId?: string | null
  tipo?: string | null
  category?: string | null
  derivedStatus: string
  integrationConfirmed: boolean
  /** Evidência produzida pelo CompletedDeploymentGitVerifier. */
  gitConfirmed: boolean
  repoPath: string
  /** Permite preservar conflitos já identificados pela seleção/verificação. */
  conflictingEvidence?: boolean
}
export type CompletedDeploymentReconciliationAction =
  | "inserted"
  | "preserved_existing"
  | "skipped_ineligible"
  | "skipped_conflict"

export interface CompletedDeploymentReconciliationItem {
  tarefaId: string | number
  externalId: string | null
  action: CompletedDeploymentReconciliationAction
  existingStatus?: string | null
  reason: string
}

export interface CompletedDeploymentReconciliationReport {
  items: CompletedDeploymentReconciliationItem[]
  inserted: CompletedDeploymentReconciliationItem[]
  preserved: CompletedDeploymentReconciliationItem[]
  skipped: CompletedDeploymentReconciliationItem[]
}

interface ExistingDeployment {
  status: string
}

function taskId(candidate: CompletedDeploymentReconciliationCandidate): string | number {
  return candidate.tarefaId
}

function externalId(candidate: CompletedDeploymentReconciliationCandidate): string | null {
  return candidate.externalId?.trim() || null
}

function eligible(candidate: CompletedDeploymentReconciliationCandidate): boolean {
  const category = candidate.category ?? candidate.tipo
  return category === "desenvolvimento" && candidate.derivedStatus === "completed" && candidate.integrationConfirmed && candidate.gitConfirmed
}

/**
 * Corrige somente o fato histórico de deploy. A classe não executa deploy e
 * não atualiza tarefas: sua única escrita possível é uma nova linha em
 * deploy_requests com status succeeded.
 */
export class CompletedDeploymentReconciler {
  constructor(private readonly db: Db) {}

  async reconcile(candidates: readonly CompletedDeploymentReconciliationCandidate[]): Promise<CompletedDeploymentReconciliationReport> {
    const items: CompletedDeploymentReconciliationItem[] = []
    const pending = candidates.filter((candidate) => {
      if (candidate.conflictingEvidence) {
        items.push({ tarefaId: taskId(candidate), externalId: externalId(candidate), action: "skipped_conflict", reason: "evidências conflitantes; nenhum registro foi alterado" })
        return false
      }
      if (!eligible(candidate)) {
        items.push({ tarefaId: taskId(candidate), externalId: externalId(candidate), action: "skipped_ineligible", reason: "não atende tipo desenvolvimento, status completed e integração Git confirmada" })
        return false
      }
      return true
    })

    await this.db.transaction(async (tx) => {
      for (const candidate of pending) {
        const existing = await tx.query(
          "SELECT status FROM deploy_requests WHERE tarefa_id = ? LIMIT 1",
          [taskId(candidate)],
        )
        const row = existing.rows[0] as ExistingDeployment | undefined
        if (row) {
          const item: CompletedDeploymentReconciliationItem = {
            tarefaId: taskId(candidate),
            externalId: externalId(candidate),
            action: "preserved_existing",
            existingStatus: String(row.status),
            reason: `registro existente (${String(row.status)}); preservado por idempotência`,
          }
          items.push(item)
          continue
        }

        // A restrição deploy_requests_tarefa_unique também cobre uma corrida
        // entre reconciliadores. O UPDATE é deliberadamente um no-op: nenhum
        // status ou campo de um registro existente é sobrescrito.
        await tx.query(
          "INSERT INTO deploy_requests (tarefa_id, repo_path, status, requested_at, updated_at) VALUES (?, ?, 'succeeded', NOW(), NOW()) " +
          "ON DUPLICATE KEY UPDATE tarefa_id = tarefa_id",
          [taskId(candidate), candidate.repoPath],
        )
        items.push({
          tarefaId: taskId(candidate),
          externalId: externalId(candidate),
          action: "inserted",
          existingStatus: "succeeded",
          reason: "solicitação histórica succeeded inserida de forma idempotente",
        })
      }
    })

    return {
      items,
      inserted: items.filter((item) => item.action === "inserted"),
      preserved: items.filter((item) => item.action === "preserved_existing"),
      skipped: items.filter((item) => item.action === "skipped_ineligible" || item.action === "skipped_conflict"),
    }
  }
}
