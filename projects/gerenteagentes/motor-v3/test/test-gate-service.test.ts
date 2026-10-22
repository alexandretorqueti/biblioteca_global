import { describe, expect, it, vi } from 'vitest'
import { TestGateService } from '../src/testing/TestGateService.js'
import type { TestGateInput, TestRunResult } from '../src/testing/TestGateService.js'
import type { Pool, RowDataPacket } from 'mysql2/promise'

describe('TestGateService', () => {
  const service = new TestGateService({} as never)

  it('normaliza caminhos de worktrees e reconhece a mesma falha no baseline', () => {
    const baseline = service.parseFailures(`FAIL projects/app/test/example.test.ts > exemplo > falha\nAssertionError: expected 1 to be 2\n at /data/workspace/projects/agentes/x/worktrees/task/1/a1/projects/app/test/example.test.ts:10:2`)
    const after = service.parseFailures(`FAIL projects/app/test/example.test.ts > exemplo > falha\nAssertionError: expected 1 to be 2\n at /data/workspace/projects/agentes/y/worktrees/task/1/a1/projects/app/test/example.test.ts:10:2`)
    const result = service.compare(after, baseline)
    expect(result.newFailures).toHaveLength(0)
    expect(result.preExistingFailures).toHaveLength(1)
    expect(result.preExistingFailures[0]?.classification).toBe('pre_existing')
  })

  it('gera o mesmo fingerprint para a integração e o worktree da subtarefa', () => {
    const baseline = service.parseFailures(`FAIL projects/gerenteagentes/motor-v3/test/queue.test.ts\nError: Cannot find package 'amqplib' imported from /data/workspace/projects/agentes/gerenteagentes/worktrees/task-p6-861/integration/projects/gerenteagentes/motor-v3/src/queue/RabbitMqTransport.ts`)
    const after = service.parseFailures(`FAIL projects/gerenteagentes/motor-v3/test/queue.test.ts\nError: Cannot find package 'amqplib' imported from /data/workspace/projects/agentes/gerenteagentes/worktrees/task-p6-861/1172/a1/projects/gerenteagentes/motor-v3/src/queue/RabbitMqTransport.ts`)
    expect(after[0]?.fingerprint).toBe(baseline[0]?.fingerprint)
    expect(service.compare(after, baseline).newFailures).toHaveLength(0)
  })

  it('classifica falhas novas e resolvidas', () => {
    const baseline = service.parseFailures(`FAIL tests/old.test.ts > antigo\nError: erro antigo`)
    const after = service.parseFailures(`FAIL tests/new.test.ts > novo\nTypeError: erro novo`)
    const result = service.compare(after, baseline)
    expect(result.newFailures.map(failure => failure.suite)).toEqual(['tests/new.test.ts'])
    expect(result.resolvedFailures.map(failure => failure.suite)).toEqual(['tests/old.test.ts'])
  })

  it('transforma falha de setup sem suíte em fingerprint auditável', () => {
    const failures = service.parseFailures(`npm error command failed\nError: Cannot find module 'vitest'`)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ suite: 'test-setup', errorType: 'SetupFailure' })
  })

  it('classifica aumento de ocorrências como worsened', () => {
    const baseline = service.parseFailures(`FAIL tests/a.test.ts > caso\nError: boom`)
    const after = service.parseFailures(`FAIL tests/a.test.ts > caso\nError: boom\nFAIL tests/a.test.ts > caso\nError: boom`)
    const result = service.compare(after, baseline)
    expect(result.newFailures).toHaveLength(1)
    expect(result.newFailures[0]?.classification).toBe('worsened')
  })

  it('serializa execuções que usam o mesmo workspace', async () => {
    const entered: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
    class ObservableGate extends TestGateService {
      protected override async runExclusive(input: TestGateInput): Promise<TestRunResult> {
        entered.push(input.phase)
        if (input.phase === 'baseline') await firstBlocked
        return { id: 1, phase: input.phase, status: 'passed', comparisonStatus: 'not_compared', exitCode: 0,
          failures: [], newFailures: [], preExistingFailures: [], resolvedFailures: [], stdout: '', stderr: '' }
      }
    }
    const gate = new ObservableGate({} as never)
    const input = { projectId: 1, taskDatabaseId: 1, commitSha: 'abc', branchName: 'test',
      workspacePath: '/tmp/shared-worktree', buildCommand: 'npm ci', testCommand: 'npm test' } as const
    const first = gate.run({ ...input, phase: 'baseline' })
    await Promise.resolve()
    const second = gate.run({ ...input, phase: 'monitor_recovery' })
    await Promise.resolve()
    expect(entered).toEqual(['baseline'])
    releaseFirst()
    await Promise.all([first, second])
    expect(entered).toEqual(['baseline', 'monitor_recovery'])
  })

  describe('dryRunTargetPool (incidente tarefa 1023: dry-run no banco do projeto)', () => {
    class ExposedGate extends TestGateService {
      public resolveTargetPool(projectId: number) {
        return this.dryRunTargetPool(projectId)
      }
    }

    function mockMotorPool(responses: unknown[][]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
      const query = vi.fn()
      for (const response of responses) query.mockResolvedValueOnce([response, []] as [RowDataPacket[], unknown])
      return { pool: { query } as unknown as Pool, query }
    }

    it('usa o banco do projeto quando há mapeamento e schema provisionado', async () => {
      const { pool, query } = mockMotorPool([
        [{ plataforma_projeto_id: 8496 }],
        [{ SCHEMA_NAME: 'projeto_8496' }],
      ])
      const gate = new ExposedGate(pool)
      const target = await gate.resolveTargetPool(13)
      try {
        expect(target.owned).toBe(true)
        expect(target.pool).not.toBe(pool)
        const config = (target.pool as unknown as { pool: { config: { connectionConfig: { database: string } } } }).pool.config.connectionConfig
        expect(config.database).toBe('projeto_8496')
        expect(query.mock.calls[0]![0]).toContain('projetos_captados')
        expect(query.mock.calls[0]![1]).toEqual([13])
      } finally {
        if (target.owned) await target.pool.end().catch(() => undefined)
      }
    })

    it('mantém o pool do motor quando o projeto não tem plataforma_projeto_id', async () => {
      const { pool } = mockMotorPool([[{ plataforma_projeto_id: null }]])
      const gate = new ExposedGate(pool)
      const target = await gate.resolveTargetPool(12)
      expect(target.owned).toBe(false)
      expect(target.pool).toBe(pool)
    })

    it('mantém o pool do motor quando o banco do projeto ainda não foi provisionado', async () => {
      const { pool } = mockMotorPool([
        [{ plataforma_projeto_id: 9999 }],
        [],
      ])
      const gate = new ExposedGate(pool)
      const target = await gate.resolveTargetPool(99)
      expect(target.owned).toBe(false)
      expect(target.pool).toBe(pool)
    })

    it('mantém o pool do motor quando o projeto não existe em projetos_captados', async () => {
      const { pool } = mockMotorPool([[]])
      const gate = new ExposedGate(pool)
      const target = await gate.resolveTargetPool(1234)
      expect(target.owned).toBe(false)
      expect(target.pool).toBe(pool)
    })
  })
})
// @vitest-environment node
