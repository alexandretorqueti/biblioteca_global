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
    const message = createQueueMessage({
      type: 'TEST_RUN_REQUESTED', taskId: source.taskId, executionId: source.executionId,
      correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
      payload: { input },
    })
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [job] = await connection.query<ResultSetHeader>(
        `INSERT INTO test_gate_jobs (request_message_id,tarefa_id,subtarefa_id,phase,status,input_json)
         VALUES (?,?,?,?, 'pending', ?)`,
        [message.messageId, input.taskDatabaseId, input.subtaskId ?? null, input.phase, JSON.stringify(input)],
      )
      await connection.query(
        `INSERT INTO motor_outbox
          (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
         VALUES (?,?,?,?,?,?,NOW(),?,?,'pending',0)`,
        [message.messageId, message.type, this.gateQueue, message.taskId, message.executionId,
          JSON.stringify({ jobId: job.insertId }), message.correlationId ?? null, message.causationId ?? null],
      )
      await connection.commit()
      return await this.wait(job.insertId)
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
    throw new Error(`Timeout aguardando gate durável ${jobId}`)
  }
}
