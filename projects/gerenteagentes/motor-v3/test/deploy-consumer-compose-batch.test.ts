import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ command: string; args: string[] }> = []
let headReads = 0
let cherryOutput = '+ cccccccccccccccccccccccccccccccccccc\n'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return callback(null, { stdout: '/repo\n', stderr: '' })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads += 1
      return callback(null, { stdout: `${headReads === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') return callback(new Error('commit is not contained'), { stdout: '', stderr: '' })
    if (command === 'git' && args[0] === 'cherry') return callback(null, { stdout: cherryOutput, stderr: '' })
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.composeBatch', () => {
  it('usa o commit efetivo do worktree para comparar patches', async () => {
    calls.length = 0
    headReads = 0
    cherryOutput = '+ cccccccccccccccccccccccccccccccccccc\n'
    const consumer = new DeployConsumer({} as never, {} as never, {} as never)

    await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-1', [
      'dddddddddddddddddddddddddddddddddddd',
    ])

    const cherry = calls.find(call => call.command === 'git' && call.args[0] === 'cherry')
    expect(cherry?.args).toEqual([
      'cherry',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'dddddddddddddddddddddddddddddddddddd',
    ])
    expect(calls.some(call => call.command === 'git' && call.args[0] === 'cherry-pick')).toBe(true)
  })

  it('não reaplica um commit cujo patch equivalente já está na base', async () => {
    calls.length = 0
    headReads = 0
    cherryOutput = '- cccccccccccccccccccccccccccccccccccc\n'

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-equivalent', [
      'dddddddddddddddddddddddddddddddddddd',
    ])

    expect(calls.some(call => call.command === 'git' && call.args[0] === 'cherry-pick')).toBe(false)
    expect(calls.some(call => call.command === 'git' && call.args[0] === 'cherry' && call.args.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBe(true)
  })
})
