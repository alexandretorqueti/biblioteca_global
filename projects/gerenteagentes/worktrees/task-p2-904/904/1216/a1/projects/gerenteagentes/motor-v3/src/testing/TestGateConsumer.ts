import { randomUUID } from 'node:crypto'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/index.js'
import type { OperationLogger } from '../commands/index.js'
import { TestGateService, type TestGateInput } from './TestGateService.js'

interface JobRow extends RowDataPacket { id: number; status: string; input_json: string | TestGateInput }

export class TestGateConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly service: TestGateService,
    private readonly logger?: OperationLogger,
    private readonly mainQueue = process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands',
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== 'TEST_RUN_REQUESTED') return
    const jobId = Number(message.payload.jobId)
    const operationId = randomUUID()
    const [claimed] = await this.pool.query<ResultSetHeader>(
      `UPDATE test_gate_jobs SET status='processing',started_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND (status='pending' OR (status='processing' AND updated_at < DATE_SUB(NOW(), INTERVAL 20 MINUTE)))`, [jobId],
    )
    if (claimed.affectedRows !== 1) {
      const [state] = await this.pool.query<Array<RowDataPacket & { status: string }>>('SELECT status FROM test_gate_jobs WHERE id=?', [jobId])
      if (state[0]?.status === 'completed' || state[0]?.status === 'failed') return
      throw new Error(`Gate ${jobId} já está em processamento; solicitar retry sem confirmar a mensagem`)
    }
    await this.logger?.append({ operationId, sequence: 1, phase: 'received', outcome: 'executed', messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId })
    try {
      const [rows] = await this.pool.query<JobRow[]>('SELECT id,status,input_json FROM test_gate_jobs WHERE id=?', [jobId])
      const raw = rows[0]?.input_json
      const input = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TestGateInput
      const result = await this.service.run(input)
      const durableResult = { ...result, stdout: '', stderr: '' }
      const completed = createQueueMessage({
        type: 'TEST_RUN_COMPLETED', taskId: message.taskId, executionId: message.executionId,
        correlationId: message.correlationId ?? message.messageId, causationId: message.messageId,
        payload: { jobId, testRunId: result.id, phase: result.phase, status: result.status, comparisonStatus: result.comparisonStatus },
      })
      const connection = await this.pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.query(`UPDATE test_gate_jobs SET status='completed',test_run_id=?,result_json=?,completion_message_id=?,finished_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [result.id, JSON.stringify(durableResult), completed.messageId, jobId])
        await connection.query(`INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt) VALUES (?,?,?,?,?,?,NOW(),?,?,'pending',0)`, [completed.messageId, completed.type, this.mainQueue, completed.taskId, completed.executionId, JSON.stringify(completed.payload), completed.correlationId ?? null, completed.causationId ?? null])
        await connection.commit()
      } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
      await this.logger?.append({ operationId, sequence: 2, phase: 'completed', outcome: 'succeeded', messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, primitiveCode: 'run_test_gate', result: { jobId, testRunId: result.id, phase: result.phase, status: result.status } })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.pool.query(`UPDATE test_gate_jobs SET status='failed',error_message=?,finished_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [reason, jobId])
      await this.logger?.append({ operationId, sequence: 2, phase: 'failed', outcome: 'failed', messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, primitiveCode: 'run_test_gate', result: { jobId, error: reason } })
      throw error
    }
  }
}
