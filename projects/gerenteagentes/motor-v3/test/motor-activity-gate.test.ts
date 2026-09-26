import { describe, expect, it, vi } from 'vitest'
import { MotorActivityGate } from '../src/queue/MotorActivityGate.js'

function poolWith(value: unknown) {
  return { query: vi.fn(async () => [[...(value === undefined ? [] : [{ valor: value }])], []]) } as any
}

describe('MotorActivityGate', () => {
  it('considera ativo por padrão quando a configuração ainda não existe', async () => {
    expect(await new MotorActivityGate(poolWith(undefined)).isActive()).toBe(true)
  })

  it.each([false, 0, 'false'])('considera o Motor inativo para %s', async value => {
    expect(await new MotorActivityGate(poolWith(value)).isActive()).toBe(false)
  })

  it('bloqueia apenas mensagens que iniciam novas atividades', () => {
    const gate = new MotorActivityGate(poolWith(true))
    expect(gate.isActivityStart('TASK_RESUME_REQUESTED')).toBe(true)
    expect(gate.isActivityStart('SUBTASK_EXECUTION_REQUESTED')).toBe(true)
    // O gate de uma execução DEV já iniciada precisa terminar normalmente.
    expect(gate.isActivityStart('TEST_RUN_REQUESTED')).toBe(false)
    expect(gate.isActivityStart('SUBTASK_EXECUTION_COMPLETED')).toBe(false)
    expect(gate.isActivityStart('TASK_CANCEL_REQUESTED')).toBe(false)
    expect(gate.isActivityStart('DEPLOY_BATCH_RESULT_RECEIVED')).toBe(false)
  })
})
