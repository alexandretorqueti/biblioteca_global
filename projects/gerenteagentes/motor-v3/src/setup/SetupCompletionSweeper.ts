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
 * tem `setup_status IN ('queued','running','pending')` — ou `setup_status =
 * 'failed'` com cooldown (ver abaixo) — e executa a MESMA função de
 * reconciliação do consumidor (`reconcileSetupCompletion`).
 *
 * RETENTATIVA DE SETUP REPROVADO (incidente 2026-11-21): a reconciliação da
 * conclusão roda ANTES do deploy materializar o projeto na base — o gate de
 * artefatos (`docs/CONTEXTO-ANALISTA.md` em `<repo>/projects/<slug>`) reprova
 * legitimamente nesse instante, mas sem nova chance o `failed` vira PERMANENTE
 * mesmo depois que o deploy do setup succeede e os artefatos chegam à base
 * (casos reais: setup-gerenteagentes 19/11 — reprovado 23:31, deploy succeeded
 * 23:34; setup-voz-na-isa; setup-calculadora-de-investimentos-gabriel). Como
 * o gate é determinístico e a reconciliação é idempotente, setups 'failed'
 * voltam à varredura com cooldown de 15 min (`projetos_captados.updated_at`,
 * que a própria reconciliação atualiza a cada passagem) até convergirem para
 * 'verified' — ou seguirem 'failed' com a razão honesta (ex.: evidência
 * smoke_test realmente ausente). A liberação das tarefas retidas continua a
 * cargo do loop de capacity wait ('setup_not_verified').
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
      // (SUBSTRING a partir do caractere 7). Setups 'failed' retornam à
      // varredura com cooldown de 15 min — a reconciliação da conclusão roda
      // antes do deploy materializar os artefatos na base, e sem retentativa
      // o 'failed' pré-deploy viraria permanente (detalhes no doc da classe).
      const [rows] = await this.pool.query<Array<RowDataPacket & { id: number; external_id: string }>>(
        `SELECT t.id, t.external_id
           FROM tarefas t
           INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
           INNER JOIN projetos_captados pc ON pc.slug = SUBSTRING(t.external_id, 7)
          WHERE t.external_id LIKE 'setup-%'
            AND f.terminal_status = 'completed'
            AND (
              pc.setup_status IN ('queued', 'running', 'pending')
              OR (pc.setup_status = 'failed' AND pc.updated_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE))
            )
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
