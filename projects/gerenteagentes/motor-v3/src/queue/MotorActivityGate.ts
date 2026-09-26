import type { Pool, RowDataPacket } from 'mysql2/promise'

const ACTIVITY_START_MESSAGES = new Set([
  'TASK_RESUME_REQUESTED',
  'TASK_READY_FOR_PROGRAMMING',
  'SUBTASK_EXECUTION_REQUESTED',
  'TEST_BASELINE_RECOVERY_REQUESTED',
  'TASK_BLOCKED',
  'TASK_ADJUSTMENT_REQUESTED',
])

interface ActiveRow extends RowDataPacket { valor: boolean | number | string | null }

/** Barreira persistente para impedir somente o início de novas atividades. */
export class MotorActivityGate {
  constructor(private readonly pool: Pool) {}

  isActivityStart(messageType: string): boolean {
    return ACTIVITY_START_MESSAGES.has(messageType)
  }

  async isActive(): Promise<boolean> {
    const [rows] = await this.pool.query<ActiveRow[]>(
      `SELECT valor FROM motor_configuracoes WHERE chave = 'motor.active' LIMIT 1`,
    )
    const value = rows[0]?.valor
    if (value == null) return true
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    return value === 'true' || value === '1'
  }
}
