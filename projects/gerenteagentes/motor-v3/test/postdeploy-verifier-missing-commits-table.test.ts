// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PostDeployVerifier } from '../src/monitor/PostDeployVerifier.js'
import type { PostDeployPromptResolver } from '../src/monitor/PostDeployPromptResolver.js'
import type { QueueMessage } from '../src/queue/index.js'
import type { WorkerLauncher } from '../src/worker-launcher/WorkerLauncher.js'
import type { TaskEventSink } from '../src/coordinator/TaskEventRecorder.js'
import type { MonitorHumanNotifier } from '../src/monitor/HumanNotifier.js'
import type { OperationLogger } from '../src/commands/index.js'

/**
 * Regressão da tabela fantasma `motor_subtask_commits` (batch deploy-1fe45c83,
 * mesma classe do incidente task-p2-984 corrigido em f7589d69): a tabela nunca
 * existiu em schema/migrations, e toda verificação pós-deploy falhava com
 * "Table ... doesn't exist" (errno 1146) em silêncio.
 *
 * - errno 1146 na query de commits → tolerado; verificação segue até o veredito.
 * - Qualquer outro erro SQL na mesma query → continua propagando (falha terminal).
 */

interface MockVerificationRow {
  id: number
  batch_id: string
  status: string
  verdict_json: string | null
  retry_count: number
}

/** Pool mock cujo comportamento da query de motor_subtask_commits é injetável. */
function createMockPool(state: {
  verifications: MockVerificationRow[]
  nextId: number
  commitsQueryBehavior: 'missing_table' | 'other_error' | 'ok'
}) {
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlLower = sql.toLowerCase().trim()

      if (sqlLower.includes('insert ignore into motor_postdeploy_verifications')) {
        const batchId = (params as string[])[0]
        if (state.verifications.some(v => v.batch_id === batchId)) {
          return [{ affectedRows: 0 }]
        }
        state.verifications.push({
          id: state.nextId++,
          batch_id: batchId,
          status: 'pending',
          verdict_json: null,
          retry_count: 0,
        })
        return [{ affectedRows: 1 }]
      }

      if (
        sqlLower.includes('insert into motor_postdeploy_verifications') &&
        sqlLower.includes('on duplicate key update')
      ) {
        const [batchId, status, verdictJson, retryCount] = params as [
          string,
          string,
          string | null,
          number,
        ]
        const existing = state.verifications.find(v => v.batch_id === batchId)
        if (existing) {
          existing.status = status
          existing.verdict_json = verdictJson
          existing.retry_count = retryCount
        } else {
          state.verifications.push({
            id: state.nextId++,
            batch_id: batchId,
            status,
            verdict_json: verdictJson,
            retry_count: retryCount,
          })
        }
        return [{}]
      }

      if (
        sqlLower.includes('select') &&
        sqlLower.includes('motor_postdeploy_verifications') &&
        sqlLower.includes('where batch_id')
      ) {
        const batchId = (params as string[])[0]
        const row = state.verifications.find(v => v.batch_id === batchId)
        return [row ? [row] : []]
      }

      if (sqlLower.includes('motor_configuracoes') && sqlLower.includes('motor.postdeploy_verification.active')) {
        return [[{ valor: true }]]
      }

      if (sqlLower.includes('deploy_requests') && sqlLower.includes('tarefas')) {
        return [[{
          database_task_id: 1,
          task_id: 'task-001',
          titulo: 'Test task',
          descricao: 'Test description',
          projeto_id: 1,
          project_slug: 'test-project',
          repo_path: '/tmp/repo',
          criterios_aceite: null,
        }]]
      }

      // IMPORTANTE: antes do branch de `subtarefas` — a query de commits contém
      // a subquery `FROM subtarefas WHERE tarefa_id = ?` e casaria com ele.
      if (sqlLower.includes('motor_subtask_commits')) {
        if (state.commitsQueryBehavior === 'missing_table') {
          throw Object.assign(
            new Error("Table 'projeto_640.motor_subtask_commits' doesn't exist"),
            { errno: 1146, code: 'ER_NO_SUCH_TABLE' },
          )
        }
        if (state.commitsQueryBehavior === 'other_error') {
          throw Object.assign(
            new Error("Unknown column 'commit_sha' in 'field list'"),
            { errno: 1054, code: 'ER_BAD_FIELD_ERROR' },
          )
        }
        return [[{
          commit_sha: 'abc1234',
          commit_message: 'fix',
          files_changed: 1,
          insertions: 5,
          deletions: 2,
        }]]
      }

      if (sqlLower.includes('subtarefas') && sqlLower.includes('where tarefa_id')) {
        return [[{ id: 1, titulo: 'Subtask 1', completion_kind: 'code_change', status: 'done' }]]
      }

      if (sqlLower.includes('test_runs')) {
        return [[{
          id: 1,
          phase: 'build',
          status: 'passed',
          passed_count: 10,
          failed_count: 0,
          duration_ms: 5000,
        }]]
      }

      if (sqlLower.includes('deploy_batches') && sqlLower.includes('where batch_id')) {
        return [[{ last_error: null, started_at: new Date(), finished_at: new Date() }]]
      }

      if (sqlLower.includes('project_model_selection')) {
        return [[{ model: 'test-model' }]]
      }

      if (sqlLower.includes('insert into motor_active_executions')) {
        return [{}]
      }

      if (sqlLower.includes('delete from motor_active_executions')) {
        return [{}]
      }

      return [[]]
    }),
    getConnection: vi.fn(),
  } as any

  return pool
}

function createMockWorker(): Pick<WorkerLauncher, 'executeTask'> {
  return {
    executeTask: vi.fn(async () => ({
      success: true,
      response: 'VEREDITO: CONSISTENTE\n\n## Findings\n\nNenhum finding.',
      attempts: 1,
      model: 'test-model',
    })),
  }
}

function createMockPromptResolver(): PostDeployPromptResolver {
  return {
    resolve: vi.fn(async () => ({
      text: 'Test prompt',
      promptId: 1,
      versionId: 1,
      executionRowId: 1,
    })),
  } as any
}

function createMockEvents(): TaskEventSink {
  return { record: vi.fn(async () => {}) }
}

function createMockNotifier(): MonitorHumanNotifier {
  return { notify: vi.fn(async () => {}) }
}

function createMockLogger(): OperationLogger {
  return { append: vi.fn(async () => {}) }
}

function createSuccessMessage(batchId: string): QueueMessage {
  return {
    messageId: `msg-${batchId}`,
    type: 'DEPLOY_BATCH_SUCCEEDED',
    taskId: 'task-001',
    executionId: `exec-${batchId}`,
    timestamp: new Date().toISOString(),
    payload: { batchId },
    attempt: 1,
  }
}

describe('PostDeployVerifier — tolerância à tabela fantasma motor_subtask_commits', () => {
  it('errno 1146 na query de commits não aborta a verificação', async () => {
    const state = {
      verifications: [] as MockVerificationRow[],
      nextId: 1,
      commitsQueryBehavior: 'missing_table' as const,
    }
    const pool = createMockPool(state)
    const worker = createMockWorker()

    const verifier = new PostDeployVerifier(
      pool,
      worker,
      createMockPromptResolver(),
      createMockEvents(),
      createMockNotifier(),
      createMockLogger(),
    )
    await verifier.handle(createSuccessMessage('batch-missing-table'))

    // A verificação deve chegar ao veredito final em vez de falhar no buildContext.
    expect(worker.executeTask).toHaveBeenCalled()
    expect(state.verifications).toHaveLength(1)
    expect(state.verifications[0]!.status).toBe('consistent')
  })

  it('outros erros SQL na query de commits continuam propagando (falha terminal)', async () => {
    const state = {
      verifications: [] as MockVerificationRow[],
      nextId: 1,
      commitsQueryBehavior: 'other_error' as const,
    }
    const pool = createMockPool(state)
    const worker = createMockWorker()

    const verifier = new PostDeployVerifier(
      pool,
      worker,
      createMockPromptResolver(),
      createMockEvents(),
      createMockNotifier(),
      createMockLogger(),
    )
    await verifier.handle(createSuccessMessage('batch-other-error'))

    // O worker não chega a rodar e a verificação é persistida como failed.
    expect(worker.executeTask).not.toHaveBeenCalled()
    expect(state.verifications).toHaveLength(1)
    expect(state.verifications[0]!.status).toBe('failed')
  })

  it('com a tabela presente, os commits seguem alimentando o contexto', async () => {
    const state = {
      verifications: [] as MockVerificationRow[],
      nextId: 1,
      commitsQueryBehavior: 'ok' as const,
    }
    const pool = createMockPool(state)
    const worker = createMockWorker()
    const prompts = createMockPromptResolver()

    const verifier = new PostDeployVerifier(
      pool,
      worker,
      prompts,
      createMockEvents(),
      createMockNotifier(),
      createMockLogger(),
    )
    await verifier.handle(createSuccessMessage('batch-table-ok'))

    expect(state.verifications[0]!.status).toBe('consistent')
    const resolveMock = prompts.resolve as unknown as ReturnType<typeof vi.fn>
    expect(resolveMock).toHaveBeenCalled()
  })
})
