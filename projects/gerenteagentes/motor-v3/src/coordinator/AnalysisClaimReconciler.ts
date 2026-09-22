import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface OrphanAnalysisClaim {
  tarefaId: number
  taskExternalId: string | null
  analysisExecutionId: string | null
  analysisStartedAt: string
}

interface OrphanRow extends RowDataPacket {
  tarefa_id: number
  external_id: string | null
  analysis_execution_id: string | null
  analysis_started_at: Date | string
}

/**
 * Recuperação de claims de análise órfãos deixados por queda do Motor
 * (incidente 862, 2026-09-22).
 *
 * O claim (`task_runtime_facts.analysis_started_at` + `analysis_execution_id`)
 * só é liberado pelo TaskCoordinator ao concluir ou falhar a análise. Se o
 * processo morre durante a execução, o claim permanece; e se a mensagem
 * durável não for reentregue ao coordenador (consumida como "completed",
 * enviada para DLQ ou fila desativada), nada mais libera o claim — a tarefa
 * congela em "analyzing" e bloqueia cancelamento/exclusão.
 *
 * Premissa de instância única (docs/CONCORRENCIA-E-LOCKS-MOTOR.md): no boot
 * não existe análise viva neste processo, portanto qualquer claim remanescente
 * é órfão. A liberação é idempotente e não corre com consumidores porque o
 * reconciliador roda antes do `QueueConsumer.start()`. Se a mensagem original
 * ainda for reentregue depois, o fluxo normal apenas reivindica a análise de
 * novo (claim atômico), sem duplicação.
 */
export class AnalysisClaimReconciler {
  constructor(private readonly pool: Pool) {}

  /** Libera todos os claims de análise pendentes no boot. Retorna os claims liberados. */
  async reconcile(): Promise<OrphanAnalysisClaim[]> {
    const [rows] = await this.pool.query<OrphanRow[]>(`
      SELECT f.tarefa_id, t.external_id, f.analysis_execution_id, f.analysis_started_at
      FROM task_runtime_facts f
      INNER JOIN tarefas t ON t.id = f.tarefa_id
      WHERE f.analysis_started_at IS NOT NULL
    `)
    const orphans: OrphanAnalysisClaim[] = rows.map(row => ({
      tarefaId: Number(row.tarefa_id),
      taskExternalId: row.external_id == null ? null : String(row.external_id),
      analysisExecutionId: row.analysis_execution_id == null ? null : String(row.analysis_execution_id),
      analysisStartedAt: row.analysis_started_at instanceof Date
        ? row.analysis_started_at.toISOString()
        : String(row.analysis_started_at),
    }))

    for (const orphan of orphans) {
      await this.pool.query(
        `UPDATE task_runtime_facts
         SET analysis_started_at = NULL, analysis_execution_id = NULL, updated_at = NOW()
         WHERE tarefa_id = ? AND analysis_started_at IS NOT NULL`,
        [orphan.tarefaId],
      )
    }
    return orphans
  }
}
