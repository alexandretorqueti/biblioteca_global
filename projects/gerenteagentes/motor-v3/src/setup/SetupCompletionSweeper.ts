import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import type { FsLike } from './ProjectSetupGate.js'
import { reconcileSetupCompletion, SETUP_TASK_PREFIX, type SetupReconciliationResult } from './SetupCompletionConsumer.js'

export interface SetupCompletionSweeperConfig {
  taskEvents?: TaskEventSink
  /** fs injetável para testes (padrão: node:fs/promises via ProjectSetupGate). */
  fs?: FsLike
  intervalMs?: number
}

/**
 * Rede de segurança durável da reconciliação de `setup_status`
 * (task-p2-1072, subtarefa 2; regra MEMORY 2026-09-25: todo estado durável
 * precisa de reconciliador de órfãos no boot — padrão
 * TestGateJobReconciler/AnalysisClaimReconciler).
 *
 * Varredura no boot + periódica que localiza tarefas `setup-*` com
 * `task_runtime_facts.terminal_status='completed'` cujo projeto alvo ainda
 * tem `setup_status IN ('queued','running','pending')` e executa a MESMA
 * função de reconciliação do consumidor (`reconcileSetupCompletion`).
 *
 * Cobre conclusões sem evento TASK_EXECUTION_COMPLETED consumível:
 * - os três caminhos de conclusão de `DevelopmentExecutionRepository`
 *   (integração, análise/no-code-change e reconciled completion) quando a
 *   mensagem se perde (DLQ, swap blue-green no meio do consumo);
 * - o `ExternalResolutionHandler` (resolução externa);
 * - o passivo histórico (caso 1020: tarefa completed, projeto em 'queued' —
 *   com artefato ausente, a varredura marca 'failed' explicitamente em vez
 *   de deixar 'queued' silencioso).
 *
 * Idempotente: a função de reconciliação trata 'verified' como no-op
 * auditado e o alerta de chat é deduplicado por marcador.
 */
export class SetupCompletionSweeper {
  private timer: NodeJS.Timeout | null = null
  private readonly intervalMs: number

  constructor(
    private readonly pool: Pool,
    private readonly config: SetupCompletionSweeperConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
  }

  /**
   * Uma passagem: retorna os resultados das reconciliações executadas.
   * Erros não propagam (barreira, como nos demais reconciliadores) — a
   * próxima passagem tenta de novo.
   */
  async reconcile(origin = 'periodic_sweep'): Promise<SetupReconciliationResult[]> {
    try {
      // Tarefas setup-* concluídas cujo projeto alvo ainda não convergiu.
      // O slug do projeto alvo é o external_id sem o prefixo 'setup-'
      // (SUBSTRING a partir do caractere 7).
      const [rows] = await this.pool.query<Array<RowDataPacket & { id: number; external_id: string }>>(
        `SELECT t.id, t.external_id
           FROM tarefas t
           INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
           INNER JOIN projetos_captados pc ON pc.slug = SUBSTRING(t.external_id, 7)
          WHERE t.external_id LIKE 'setup-%'
            AND f.terminal_status = 'completed'
            AND pc.setup_status IN ('queued', 'running', 'pending')
          ORDER BY t.id`,
      )
      const results: SetupReconciliationResult[] = []
      for (const row of rows) {
        const slug = String(row.external_id).slice(SETUP_TASK_PREFIX.length)
        const result = await reconcileSetupCompletion(this.pool, slug, {
          origin,
          taskEvents: this.config.taskEvents,
          fs: this.config.fs,
        })
        results.push(result)
        console.warn(
          `[Motor v3] SetupCompletionSweeper: setup órfão reconciliado: task=${row.external_id} slug=${slug} → ${result.outcome}`,
        )
      }
      return results
    } catch (error) {
      console.error('[SetupCompletionSweeper] falha na varredura:', error instanceof Error ? error.message : error)
      return []
    }
  }

  start(): void {
    if (this.timer) return
    // `reconcile` já contém barreira de erro; o void explícito evita unhandled rejection.
    this.timer = setInterval(() => void this.reconcile('periodic_sweep'), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
