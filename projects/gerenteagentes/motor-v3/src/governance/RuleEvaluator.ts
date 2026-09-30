/** Avalia condições declarativas do catálogo sem executar código vindo do banco. */

export type RuleValue = string | number | boolean | null

export interface RuleContext {
  error?: Record<string, unknown>
  context?: Record<string, unknown>
  occurrence?: number
  [key: string]: unknown
}

type Condition = {
  all?: Condition[]
  any?: Condition[]
  field?: string
  op?: 'eq' | 'neq' | 'gte' | 'lte' | 'contains' | 'regex'
  value?: RuleValue
}

export class RuleEvaluator {
  evaluate(condition: unknown, input: RuleContext): boolean {
    if (condition == null) return true
    if (!this.isRecord(condition)) return false

    const rule = condition as Condition
    if (Array.isArray(rule.all)) return rule.all.every(child => this.evaluate(child, input))
    if (Array.isArray(rule.any)) return rule.any.some(child => this.evaluate(child, input))
    if (typeof rule.field !== 'string' || typeof rule.op !== 'string') return false

    const actual = this.resolve(rule.field, input)
    switch (rule.op) {
      case 'eq': return actual === rule.value
      case 'neq': return actual !== rule.value
      case 'gte': return this.compare(actual, rule.value, (a, b) => a >= b)
      case 'lte': return this.compare(actual, rule.value, (a, b) => a <= b)
      case 'contains':
        return typeof actual === 'string' && typeof rule.value === 'string' && actual.includes(rule.value)
      case 'regex':
        if (typeof actual !== 'string' || typeof rule.value !== 'string') return false
        try { return new RegExp(rule.value, 'i').test(actual) } catch { return false }
      default: return false
    }
  }

  private resolve(field: string, input: RuleContext): unknown {
    const [root, ...path] = field.split('.')
    if (!root) return undefined
    const source = root === 'error'
      ? input.error
      : root === 'context'
        ? input.context
        : Object.prototype.hasOwnProperty.call(input, root)
          ? input
          : input.context
    if (source == null) return undefined
    if (root !== 'error' && root !== 'context' && source === input) return input[root]
    return path.reduce<unknown>((value, key) => this.isRecord(value) ? value[key] : undefined, source)
  }

  private compare(actual: unknown, expected: unknown, predicate: (a: number, b: number) => boolean): boolean {
    const a = typeof actual === 'number' ? actual : typeof actual === 'string' ? Number(actual) : NaN
    const b = typeof expected === 'number' ? expected : typeof expected === 'string' ? Number(expected) : NaN
    return Number.isFinite(a) && Number.isFinite(b) && predicate(a, b)
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
