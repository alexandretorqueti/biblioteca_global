import { describe, expect, it } from 'vitest'
import { CommandPolicyResolver, type CommandPolicySnapshot, type CommandSnapshot, type CommandTaskFacts } from '../src/commands/index.js'

const command: CommandSnapshot = { code: 'C03_TASK_RESUME_REQUESTED', active: true, version: 1 }
const policy: CommandPolicySnapshot = {
  code: 'P03_RESUME_IF_ELIGIBLE', priority: 100,
  conditions: ['task_not_paused', 'task_not_terminal', 'task_not_blocked', 'task_has_no_subtasks', 'analysis_not_claimed'],
  actionCode: 'A21_RESUME_TASK_ANALYSIS', active: true, version: 1,
}
const eligible: CommandTaskFacts = { paused: false, terminal: false, blocked: false, subtaskCount: 0, analysisClaimed: false }

describe('CommandPolicyResolver', () => {
  it('seleciona a action da política elegível de maior prioridade', () => {
    const decision = new CommandPolicyResolver().decide(command, [policy], eligible)

    expect(decision).toMatchObject({ kind: 'execute', policy: { code: 'P03_RESUME_IF_ELIGIBLE', actionCode: 'A21_RESUME_TASK_ANALYSIS' } })
  })

  it.each([
    [{ ...eligible, paused: true }, 'task_paused'],
    [{ ...eligible, terminal: true }, 'task_terminal'],
    [{ ...eligible, blocked: true }, 'task_blocked'],
    [{ ...eligible, subtaskCount: 1 }, 'task_has_plan'],
    [{ ...eligible, analysisClaimed: true }, 'analysis_already_claimed'],
  ] as Array<[CommandTaskFacts, string]>)('rejeita com motivo auditável: %s', (facts, reasonCode) => {
    const decision = new CommandPolicyResolver().decide(command, [policy], facts)

    expect(decision).toMatchObject({ kind: 'reject', reasonCode, evaluatedPolicies: ['P03_RESUME_IF_ELIGIBLE'] })
  })

  it('não executa comando inativo', () => {
    const decision = new CommandPolicyResolver().decide({ ...command, active: false }, [policy], eligible)

    expect(decision).toMatchObject({ kind: 'reject', reasonCode: 'command_inactive' })
  })
})
// @vitest-environment node
