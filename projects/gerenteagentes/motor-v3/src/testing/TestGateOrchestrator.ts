import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/index.js'
import type { TestGateInput, TestRunResult } from './TestGateService.js'

interface JobRow extends RowDataPacket { status: string; result_json: string | TestRunResult | null; error_message: string | null }

/** Request/reply durável: publica o comando numa fila dedicada e aguarda a projeção do job. */
export class TestGateOrchestrator {
  constructor(
    private readonly pool: Pool,
    private readonly gateQueue = process.env.MOTOR_TEST_GATE_QUEUE || 'motor.test-gates',
    private readonly timeoutMs = Number(process.env.MOTOR_TEST_GATE_TIMEOUT_MS || 1_800_000),
  ) {}

  async request(input: TestGateInput, source: QueueMessage): Promise<TestRunResult> {
    const jobId = await this.enqueue(input, source)
    return this.wait(jobId)
  }

  /** Enfileira sem esperar: continuação deve reagir a TEST_RUN_COMPLETED. */
  async enqueue(input: TestGateInput, source: QueueMessage): Promise<number> {
    // A mesma mensagem de origem + fase representa a mesma continuação.
    // Reentrega/recovery não pode criar um segundo job de gate.
    const requestMessageId = `${source.messageId}:${input.phase}:${input.subtaskId ?? 'task'}`.slice(0, 100)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [job] = await connection.query<ResultSetHeader>(
        `INSERT IGNORE INTO test_gate_jobs (request_message_id,tarefa_id,subtarefa_id,phase,status,input_json)
         VALUES (?,?,?,?, 'pending', ?)`,
        [requestMessageId, input.taskDatabaseId, input.subtaskId ?? null, input.phase, JSON.stringify(input)],
      )
      let jobId = Number(job.insertId)
      if (!jobId) {
        const [existing] = await connection.query<Array<RowDataPacket & { id: number }>>(
          'SELECT id FROM test_gate_jobs WHERE request_message_id=? FOR UPDATE', [requestMessageId],
        )
        jobId = Number(existing[0]?.id)
      }
      if (!jobId) throw new Error(`Não foi possível localizar o job de gate da continuação ${requestMessageId}`)
      // Só a primeira inserção publica o comando. Recovery/reentrega observa
      // o mesmo job e deixa o reconciliador cuidar de uma mensagem órfã.
      if (Number(job.affectedRows) === 1) {
        // Correlation por job: o fluxo de deploy enfileira legitimamente DOIS
        // gates pre_deploy para a mesma tarefa dentro da mesma correlação
        // (accept do pedido + batch composto) porque TEST_RUN_COMPLETED e o
        // dispatch herdam o correlationId da cadeia. A chave lógica do outbox
        // (type, task_id, correlation_id) rejeitaria o segundo INSERT com
        // ER_DUP_ENTRY e falharia o lote (incidente 2026-10-27: tarefa
        // custom-gestao-recorrencias, batch deploy-5ecea42f). O sufixo :gate:<jobId>
        // mantém a rastreabilidade da correlação original e garante unicidade
        // por job; a deduplicação de reentrega segue com request_message_id.
        const message = createQueueMessage({
          messageId: requestMessageId,
          type: 'TEST_RUN_REQUESTED', taskId: source.taskId, executionId: source.executionId,
          correlationId: `${(source.correlationId ?? source.messageId).slice(0, 180)}:gate:${jobId}`.slice(0, 200),
          causationId: source.messageId,
          payload: { input },
        })
        await connection.query(
          `INSERT INTO motor_outbox
            (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
          VALUES (?,?,?,?,?,?,NOW(),?,?,'pending',0)`,
          [message.messageId, message.type, this.gateQueue, message.taskId, message.executionId,
            JSON.stringify({ jobId }), message.correlationId ?? null, message.causationId ?? null],
        )
      }
      await connection.commit()
      return jobId
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  }

  private async wait(jobId: number): Promise<TestRunResult> {
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      const [rows] = await this.pool.query<JobRow[]>('SELECT status,result_json,error_message FROM test_gate_jobs WHERE id=?', [jobId])
      const row = rows[0]
      if (!row) throw new Error(`Job de gate ${jobId} desapareceu`)
      if (row.status === 'completed') return typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json as TestRunResult
      if (row.status === 'failed') throw new Error(row.error_message || `Gate ${jobId} falhou`)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    const reason = `Timeout aguardando gate durável ${jobId}`
    // O timeout também é uma transição durável. O UPDATE condicionado torna
    // a recuperação idempotente e não transforma um gate já concluído em
    // falha por uma leitura atrasada.
    await this.pool.query(
      `UPDATE test_gate_jobs SET status='failed',error_message=?,finished_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND status IN ('pending','processing')`,
      [reason, jobId],
    )
    throw new Error(reason)
  }
}
