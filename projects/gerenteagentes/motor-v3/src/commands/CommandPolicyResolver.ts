/**
 * Resolve políticas de comandos sem executar efeitos colaterais.
 *
 * As condições são uma lista fechada de guardas tipadas. Isto impede que uma
 * política configurada no banco injete SQL ou contorne invariantes do ciclo de
 * vida da tarefa.
 */

export const commandConditions = [
  'task_not_paused',
  'task_not_terminal',
  'task_not_blocked',
  'task_has_no_subtasks',
  'analysis_not_claimed',
] as const

export type CommandCondition = typeof commandConditions[number]

export interface CommandSnapshot {
  code: string
  active: boolean
  version: number
}

export interface CommandPolicySnapshot {
  code: string
  priority: number
  conditions: CommandCondition[]
  actionCode: string
  active: boolean
  version: number
}

export interface CommandTaskFacts {
  paused: boolean
  terminal: boolean
  blocked: boolean
  subtaskCount: number
  analysisClaimed: boolean
}

export type CommandDecision =
  | { kind: 'execute'; command: CommandSnapshot; policy: CommandPolicySnapshot }
  | { kind: 'reject'; reasonCode: string; command?: CommandSnapshot; evaluatedPolicies: string[] }

/** Retorna a primeira política ativa cujas guardas são todas satisfeitas. */
export class CommandPolicyResolver {
  decide(command: CommandSnapshot | undefined, policies: CommandPolicySnapshot[], facts: CommandTaskFacts): CommandDecision {
    if (!command) return { kind: 'reject', reasonCode: 'command_not_found', evaluatedPolicies: [] }
    if (!command.active) return { kind: 'reject', reasonCode: 'command_inactive', command, evaluatedPolicies: [] }

    const activePolicies = policies
      .filter(policy => policy.active)
      .sort((left, right) => left.priority - right.priority)

    const evaluatedPolicies: string[] = []
    for (const policy of activePolicies) {
      evaluatedPolicies.push(policy.code)
      if (policy.conditions.every(condition => this.matches(condition, facts))) {
        return { kind: 'execute', command, policy }
      }
    }
    return { kind: 'reject', reasonCode: this.rejectionReason(facts), command, evaluatedPolicies }
  }

  private matches(condition: CommandCondition, facts: CommandTaskFacts): boolean {
    switch (condition) {
      case 'task_not_paused': return !facts.paused
      case 'task_not_terminal': return !facts.terminal
      case 'task_not_blocked': return !facts.blocked
      case 'task_has_no_subtasks': return facts.subtaskCount === 0
      case 'analysis_not_claimed': return !facts.analysisClaimed
    }
  }

  private rejectionReason(facts: CommandTaskFacts): string {
    if (facts.paused) return 'task_paused'
    if (facts.terminal) return 'task_terminal'
    if (facts.blocked) return 'task_blocked'
    if (facts.subtaskCount > 0) return 'task_has_plan'
    if (facts.analysisClaimed) return 'analysis_already_claimed'
    return 'no_policy_matched'
  }
}
