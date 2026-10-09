import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
let remoteResults: Array<Error | null> = []
let githubKnownHost = false
let knownHostsContent = ''

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], options: Record<string, unknown>, callback: Function) => {
    calls.push({ command, args, options })
    if (command === 'git' && args[0] === 'ls-remote') {
      const result = remoteResults.shift()
      return result ? callback(result, { stdout: '', stderr: result.message }) : callback(null, { stdout: 'head\n', stderr: '' })
    }
    if (command === 'ssh-keygen' && args[0] === '-F') {
      return githubKnownHost
        ? callback(null, { stdout: 'github.com ssh-ed25519 key\n', stderr: '' })
        : callback(new Error('not found'), { stdout: '', stderr: '' })
    }
    if (command === 'ssh-keyscan') return callback(null, { stdout: 'github.com ssh-ed25519 scanned-key\n', stderr: '' })
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  appendFile: vi.fn(async (_path: string, contents: string) => {
    knownHostsContent += contents
    githubKnownHost = true
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

function consumer() {
  return new DeployConsumer({} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '/tmp/known_hosts', 1234)
}

function hostKeyFailure() {
  return new Error('Host key verification failed')
}

describe('DeployConsumer GitHub promote preflight', () => {
  beforeEach(() => {
    calls.length = 0
    remoteResults = []
    githubKnownHost = false
    knownHostsContent = ''
    vi.clearAllMocks()
  })

  it('tenta autocura uma vez e falha antes do push quando a verificação de host persiste', async () => {
    remoteResults = [hostKeyFailure(), hostKeyFailure()]

    await expect((consumer() as any).preflightGithubRemote('/repo')).rejects.toThrow('host_key_verification')

    expect(calls.filter(call => call.command === 'git' && call.args.join(' ') === 'ls-remote origin HEAD')).toHaveLength(2)
    expect(calls.filter(call => call.command === 'ssh-keyscan' && call.args[0] === 'github.com')).toHaveLength(1)
    expect(calls.some(call => call.command === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it('prossegue no preflight quando o remote já está acessível', async () => {
    remoteResults = [null]

    await expect((consumer() as any).preflightGithubRemote('/repo')).resolves.toBeUndefined()

    const probe = calls.find(call => call.command === 'git' && call.args.join(' ') === 'ls-remote origin HEAD')
    expect(probe?.options.timeout).toBe(1234)
    expect(calls.some(call => call.command === 'ssh-keyscan')).toBe(false)
  })

  it('não duplica github.com quando a autocura é chamada mais de uma vez', async () => {
    const instance = consumer() as any

    await instance.repairGithubKnownHosts()
    await instance.repairGithubKnownHosts()

    expect(calls.filter(call => call.command === 'ssh-keyscan' && call.args[0] === 'github.com')).toHaveLength(1)
    expect(knownHostsContent.match(/github\.com/g)).toHaveLength(1)
  })
})
