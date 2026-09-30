import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ command: string; args: string[] }> = []
let mergeFails = false

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args })
    if (command === 'git' && args[0] === 'rev-parse') return callback(null, { stdout: '/repo\n', stderr: '' })
    if (command === 'git' && args[0] === 'merge-base') return callback(new Error('not ancestor'), { stdout: '', stderr: '' })
    if (command === 'git' && args[0] === 'merge' && args[1] === '--no-ff' && mergeFails) return callback(new Error('merge conflict'), { stdout: '', stderr: '' })
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return callback(null, { stdout: mergeFails ? 'src/conflict.ts\n' : '', stderr: '' })
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.promote', () => {
  const commit = 'a'.repeat(40)

  it('cria merge explícito quando a base avançou, sem exigir fast-forward', async () => {
    calls.length = 0
    mergeFails = false
    const consumer = new DeployConsumer({} as never, {} as never, {} as never)

    await expect((consumer as any).promote('/repo', 'base-desenvolvimento', commit)).resolves.toBeUndefined()

    expect(calls.some(call => call.args.includes('--ff-only'))).toBe(false)
    expect(calls.some(call => call.args.join(' ') === `merge --no-ff --no-commit ${commit}`)).toBe(true)
    expect(calls.some(call => call.args.join(' ') === 'diff --check')).toBe(true)
    expect(calls.some(call => call.args.join(' ') === 'commit --no-edit')).toBe(true)
  })

  it('informa os arquivos quando o merge tem conflito real', async () => {
    calls.length = 0
    mergeFails = true
    const consumer = new DeployConsumer({} as never, {} as never, {} as never)

    await expect((consumer as any).promote('/repo', 'base-desenvolvimento', commit)).rejects.toThrow('src/conflict.ts')
    expect(calls.some(call => call.args.join(' ') === 'merge --abort')).toBe(true)
  })
})
