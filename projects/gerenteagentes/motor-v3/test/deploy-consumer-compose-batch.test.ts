import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ command: string; args: string[] }> = []
let headReads = 0

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return callback(null, { stdout: '/repo\n', stderr: '' })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads += 1
      return callback(null, { stdout: `${headReads === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') return callback(new Error('commit is not contained'), { stdout: '', stderr: '' })
    if (command === 'git' && args[0] === 'rev-list') return callback(null, { stdout: 'cccccccccccccccccccccccccccccccccccc\n', stderr: '' })
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.composeBatch', () => {
  it('usa o commit efetivo do worktree como base do rev-list', async () => {
    calls.length = 0
    headReads = 0
    const consumer = new DeployConsumer({} as never, {} as never, {} as never)

    await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-1', [
      'dddddddddddddddddddddddddddddddddddd',
    ])

    const revList = calls.find(call => call.command === 'git' && call.args[0] === 'rev-list')
    expect(revList?.args).toEqual([
      'rev-list', '--reverse',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..dddddddddddddddddddddddddddddddddddd',
    ])
  })
})
