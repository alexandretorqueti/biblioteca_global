import type { Pool, RowDataPacket } from 'mysql2/promise'
import { commandConditions, type CommandCondition, type CommandPolicySnapshot, type CommandSnapshot } from './CommandPolicyResolver.js'

interface PolicyRow extends RowDataPacket {
  command_code: string
  command_active: number
  command_version: number
  policy_code: string
  priority: number
  conditions_json: unknown
  action_code: string
  policy_active: number
  policy_version: number
}

export interface CommandPolicyRepository {
  findByMessageType(messageType: string): Promise<{ command: CommandSnapshot; policies: CommandPolicySnapshot[] } | null>
}

/** Lê o comando e suas políticas ativas diretamente do catálogo governável. */
export class MySqlCommandPolicyRepository implements CommandPolicyRepository {
  constructor(private readonly pool: Pool) {}

  async findByMessageType(messageType: string): Promise<{ command: CommandSnapshot; policies: CommandPolicySnapshot[] } | null> {
    const [rows] = await this.pool.query<PolicyRow[]>(`
      SELECT c.code AS command_code, c.active AS command_active, c.version AS command_version,
             p.code AS policy_code, p.priority, p.conditions_json,
             a.code AS action_code, p.active AS policy_active, p.version AS policy_version
        FROM motor_commands c
        LEFT JOIN motor_command_policies p ON p.command_id = c.id
        LEFT JOIN motor_actions a ON a.id = p.action_id
       WHERE c.message_type = ?
       ORDER BY p.priority ASC, p.id ASC`, [messageType])
    const first = rows[0]
    if (!first) return null
    const command: CommandSnapshot = { code: first.command_code, active: Number(first.command_active) === 1, version: Number(first.command_version) }
    const policies = rows.flatMap(row => {
      if (!row.policy_code || !row.action_code) return []
      return [{
        code: row.policy_code,
        priority: Number(row.priority),
        conditions: this.parseConditions(row.conditions_json),
        actionCode: row.action_code,
        active: Number(row.policy_active) === 1,
        version: Number(row.policy_version),
      } satisfies CommandPolicySnapshot]
    })
    return { command, policies }
  }

  private parseConditions(value: unknown): CommandCondition[] {
    let parsed = value
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) } catch { throw new Error('conditions_json inválido no catálogo de comandos') }
    }
    const all = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { all?: unknown }).all)
      ? (parsed as { all: unknown[] }).all : null
    if (!all || !all.every((condition): condition is CommandCondition => typeof condition === 'string' && commandConditions.includes(condition as CommandCondition))) {
      throw new Error('conditions_json contém condição não permitida')
    }
    return all
  }
}
