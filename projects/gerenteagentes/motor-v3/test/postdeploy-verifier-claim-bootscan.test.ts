// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PostDeployVerifier } from '../src/monitor/PostDeployVerifier.js'
import type { PostDeployPromptResolver } from '../src/monitor/PostDeployPromptResolver.js'
import type { QueueMessage } from '../src/queue/index.js'
import type { WorkerLauncher } from '../src/worker-launcher/WorkerLauncher.js'
import type { TaskEventSink } from '../src/coordinator/TaskEventRecorder.js'
import type { MonitorHumanNotifier } from '../src/monitor/HumanNotifier.js'
import type { OperationLogger } from '../src/commands/index.js'

/**
 * Testes da Subtarefa 1 (tarefa 976):
 * - Claim atômico idempotente (INSERT IGNORE com status pending)
 * - Boot scan de batches succeeded sem verificação
 * - Falha de modelo/parse → estado terminal sem crash
 *
 * Usa mock do Pool para simular o comportamento do INSERT IGNORE e das queries.
 */

/** Estado em memória que simula a tabela motor_postdeploy_verifications */
interface MockVerificationRow {
  id: number
  batch_id: string
  status: string
  verdict_json: string | null
  retry_count: number
}

/** Pool mock que simula INSERT IGNORE com unique key em batch_id */
function createMockPool(state: {
  verifications: MockVerificationRow[]
  deployBatches: Array<{ batch_id: string; status: string; finished_at: Date }>
  nextId: number
  workerResponse?: { success: boolean; response: string; attempts: number; model: string }
  promptError?: Error
}) {
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlLower = sql.toLowerCase().trim()

      // INSERT IGNORE INTO motor_postdeploy_verifications (claim)
      if (sqlLower.includes('insert ignore into motor_postdeploy_verifications')) {
        const batchId = (params as string[])[0]
        const exists = state.verifications.some(v => v.batch_id === batchId)
        if (exists) {
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

      // INSERT ... ON DUPLICATE KEY UPDATE (persistVerification)
      if (sqlLower.includes('insert into motor_postdeploy_verifications') && sqlLower.includes('on duplicate key update')) {
        const [batchId, status, verdictJson, retryCount] = params as [string, string, string | null, number]
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

      // SELECT ... FROM motor_postdeploy_verifications (findVerification)
      if (sqlLower.includes('select') && sqlLower.includes('motor_postdeploy_verifications') && sqlLower.includes('where batch_id')) {
        const batchId = (params as string[])[0]
        const row = state.verifications.find(v => v.batch_id === batchId)
        return [row ? [row] : []]
      }

      // Boot scan query: deploy_batches LEFT JOIN motor_postdeploy_verifications
      if (sqlLower.includes('deploy_batches') && sqlLower.includes('left join motor_postdeploy_verifications')) {
        const rows = state.deployBatches
          .filter(b => b.status === 'succeeded')
          .filter(b => {
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)
            return b.finished_at >= cutoff
          })
          .filter(b => !state.verifications.some(v => v.batch_id === b.batch_id))
          .map(b => ({ batch_id: b.batch_id }))
        return [rows]
      }

      // SELECT valor FROM motor_configuracoes (isActive)
      if (sqlLower.includes('motor_configuracoes') && sqlLower.includes('motor.postdeploy_verification.active')) {
        return [[{ valor: true }]]
      }

      // SELECT ... FROM deploy_requests + tarefas (loadBatchTasks)
      if (sqlLower.includes('deploy_requests') && sqlLower.includes('tarefas')) {
        return [[{
          database_task_id: 1,
          task_id: 'task-001',
          titulo: 'Test task',
          descricao: 'Test description',
          projeto_id: 1,
          project_slug: 'test-project',
          repo_path: '/tmp/repo',
          criterios_aceite: 'Tests pass',
        }]]
      }

      // SELECT ... FROM subtarefas
      if (sqlLower.includes('subtarefas') && sqlLower.includes('where tarefa_id')) {
        return [[{ id: 1, titulo: 'Subtask 1', completion_kind: 'code_change', status: 'done' }]]
      }

      // SELECT ... FROM motor_subtask_commits
      if (sqlLower.includes('motor_subtask_commits')) {
        return [[{ commit_sha: 'abc1234', commit_message: 'fix', files_changed: 1, insertions: 5, deletions: 2 }]]
      }

      // SELECT ... FROM test_runs
      if (sqlLower.includes('test_runs')) {
        return [[{ id: 1, phase: 'build', status: 'passed', passed_count: 10, failed_count: 0, duration_ms: 5000 }]]
      }

      // SELECT ... FROM deploy_batches (diagnostics)
      if (sqlLower.includes('deploy_batches') && sqlLower.includes('where batch_id')) {
        return [[{ last_error: null, started_at: new Date(), finished_at: new Date() }]]
      }

      // SELECT model FROM project_model_selection
      if (sqlLower.includes('project_model_selection')) {
        return [[{ model: 'test-model' }]]
      }

      // INSERT INTO motor_active_executions
      if (sqlLower.includes('insert into motor_active_executions')) {
        return [{}]
      }

      // DELETE FROM motor_active_executions
      if (sqlLower.includes('delete from motor_active_executions')) {
        return [{}]
      }

      return [[]]
    }),
    getConnection: vi.fn(),
  } as any

  return pool
}

function createMockWorker(response?: { success: boolean; response: string; attempts: number; model: string }): Pick<WorkerLauncher, 'executeTask'> {
  return {
    executeTask: vi.fn(async () => response ?? {
      success: true,
      response: 'VEREDITO: CONSISTENTE\n\n## Findings\n\nNenhum finding.',
      attempts: 1,
      model: 'test-model',
    }),
  }
}

function createMockPromptResolver(error?: Error): PostDeployPromptResolver {
  return {
    resolve: vi.fn(async () => {
      if (error) throw error
      return {
        text: 'Test prompt',
        promptId: 1,
        versionId: 1,
        executionRowId: 1,
      }
    }),
  } as any
}

function createMockEvents(): TaskEventSink {
  return {
    record: vi.fn(async () => {}),
  }
}

function createMockNotifier(): MonitorHumanNotifier {
  return {
    notify: vi.fn(async () => {}),
  }
}

function createMockLogger(): OperationLogger {
  return {
    append: vi.fn(async () => {}),
  }
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

describe('PostDeployVerifier — Claim idempotente e Boot scan (Subtarefa 1 / tarefa 976)', () => {
  describe('Claim atômico (INSERT IGNORE)', () => {
    it('handle() reivindica o batch e executa verificação quando não existe linha prévia', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.handle(createSuccessMessage('batch-001'))

      // Uma linha de verificação deve ter sido criada (pelo claim) e depois atualizada (pelo persistVerification)
      expect(state.verifications).toHaveLength(1)
      const verification = state.verifications[0]!
      expect(verification.batch_id).toBe('batch-001')
      // Status final deve ser 'consistent' (veredito CONSISTENTE → mapStatus → 'consistent')
      expect(verification.status).toBe('consistent')
    })

    it('handle() NÃO executa verificação duplicada quando batch já foi reivindicado', async () => {
      const state = {
        verifications: [
          { id: 1, batch_id: 'batch-002', status: 'consistent', verdict_json: '{}', retry_count: 0 },
        ] as MockVerificationRow[],
        deployBatches: [],
        nextId: 2,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const executeTaskSpy = worker.executeTask as ReturnType<typeof vi.fn>
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.handle(createSuccessMessage('batch-002'))

      // Worker NÃO deve ter sido chamado (claim falhou porque já existe)
      expect(executeTaskSpy).not.toHaveBeenCalled()
      // Estado permanece inalterado
      expect(state.verifications).toHaveLength(1)
      expect(state.verifications[0]!.status).toBe('consistent')
    })

    it('duas chamadas concorrentes para o mesmo batch: apenas uma executa', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const executeTaskSpy = worker.executeTask as ReturnType<typeof vi.fn>
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)

      // Dispara duas chamadas sequenciais (não paralelo porque o mock é síncrono no INSERT)
      await verifier.handle(createSuccessMessage('batch-003'))
      await verifier.handle(createSuccessMessage('batch-003'))

      // Apenas uma execução do worker (primeira chamada fez o claim; segunda encontrou row existente)
      expect(executeTaskSpy).toHaveBeenCalledTimes(1)
      expect(state.verifications).toHaveLength(1)
    })
  })

  describe('Boot scan (bootScan)', () => {
    it('processa batch succeeded recente sem verificação', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [
          { batch_id: 'batch-boot-1', status: 'succeeded', finished_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2h atrás
        ],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.bootScan()

      // Batch deve ter sido reivindicado e processado
      expect(state.verifications).toHaveLength(1)
      expect(state.verifications[0]!.batch_id).toBe('batch-boot-1')
      expect(state.verifications[0]!.status).toBe('consistent')
    })

    it('ignora batch que já possui linha de verificação', async () => {
      const state = {
        verifications: [
          { id: 1, batch_id: 'batch-already', status: 'consistent', verdict_json: '{}', retry_count: 0 },
        ] as MockVerificationRow[],
        deployBatches: [
          { batch_id: 'batch-already', status: 'succeeded', finished_at: new Date(Date.now() - 1 * 60 * 60 * 1000) },
        ],
        nextId: 2,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const executeTaskSpy = worker.executeTask as ReturnType<typeof vi.fn>
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.bootScan()

      // Query de boot scan retorna vazio (LEFT JOIN com pv.id IS NULL exclui batch-already)
      // Worker não deve ser chamado
      expect(executeTaskSpy).not.toHaveBeenCalled()
      expect(state.verifications).toHaveLength(1) // Nenhuma nova
    })

    it('ignora batch succeeded fora da janela de 48 horas', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [
          { batch_id: 'batch-old', status: 'succeeded', finished_at: new Date(Date.now() - 72 * 60 * 60 * 1000) }, // 72h atrás
        ],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const executeTaskSpy = worker.executeTask as ReturnType<typeof vi.fn>
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.bootScan()

      // Query retorna vazio (batch fora da janela de 48h)
      expect(executeTaskSpy).not.toHaveBeenCalled()
      expect(state.verifications).toHaveLength(0)
    })

    it('ignora batch com status diferente de succeeded', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [
          { batch_id: 'batch-failed', status: 'failed', finished_at: new Date(Date.now() - 1 * 60 * 60 * 1000) },
          { batch_id: 'batch-running', status: 'running', finished_at: new Date(Date.now() - 1 * 60 * 60 * 1000) },
        ],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const executeTaskSpy = worker.executeTask as ReturnType<typeof vi.fn>
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.bootScan()

      expect(executeTaskSpy).not.toHaveBeenCalled()
      expect(state.verifications).toHaveLength(0)
    })

    it('bootScan NÃO propaga exceção ao chamador mesmo se query falhar', async () => {
      const pool = {
        query: vi.fn(async () => { throw new Error('DB connection lost') }),
        getConnection: vi.fn(),
      } as any
      const worker = createMockWorker()
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)

      // NÃO deve lançar — boot scan nunca derruba o startup
      await expect(verifier.bootScan()).resolves.toBeUndefined()
    })
  })

  describe('Falha de modelo/prompt/parse → estado terminal sem crash', () => {
    it('falha na resolução do prompt → status failed na tabela, sem exceção', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = createMockWorker()
      const prompts = createMockPromptResolver(new Error('prompt_configuration_missing: prompt ativo não encontrado'))
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)

      // NÃO deve lançar
      await expect(verifier.handle(createSuccessMessage('batch-prompt-fail'))).resolves.toBeUndefined()

      // Linha de verificação com status failed
      expect(state.verifications).toHaveLength(1)
      expect(state.verifications[0]!.batch_id).toBe('batch-prompt-fail')
      expect(state.verifications[0]!.status).toBe('failed')
    })

    it('falha no worker (modelo) → status failed na tabela, sem exceção', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [],
        nextId: 1,
      }
      const pool = createMockPool(state)
      const worker = {
        executeTask: vi.fn(async () => { throw new Error('model_unavailable: no API key found') }),
      } as any
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)

      await expect(verifier.handle(createSuccessMessage('batch-model-fail'))).resolves.toBeUndefined()

      expect(state.verifications).toHaveLength(1)
      expect(state.verifications[0]!.batch_id).toBe('batch-model-fail')
      expect(state.verifications[0]!.status).toBe('failed')
    })

    it('resposta não-parseável → INCONCLUSIVO reagenda (pending + retry_count=1) sem crash', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [],
        nextId: 1,
      }
      const pool = createMockPool(state)
      // Worker retorna resposta sem VEREDITO → parsePostDeployVerdict retorna INCONCLUSIVO
      const worker = createMockWorker({
        success: true,
        response: 'Resposta do modelo sem formato de veredito.',
        attempts: 1,
        model: 'test-model',
      })
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)

      await expect(verifier.handle(createSuccessMessage('batch-parse-fail'))).resolves.toBeUndefined()

      // Verificação existe; INCONCLUSIVO com retry_count < maxRetries → reagenda (pending, retry_count=1)
      expect(state.verifications).toHaveLength(1)
      expect(state.verifications[0]!.batch_id).toBe('batch-parse-fail')
      expect(state.verifications[0]!.status).toBe('pending')
      expect(state.verifications[0]!.retry_count).toBe(1)
    })

    it('boot scan: falha em batch individual não impede processamento dos demais', async () => {
      const state = {
        verifications: [] as MockVerificationRow[],
        deployBatches: [
          { batch_id: 'batch-fail', status: 'succeeded', finished_at: new Date(Date.now() - 1 * 60 * 60 * 1000) },
          { batch_id: 'batch-ok', status: 'succeeded', finished_at: new Date(Date.now() - 1 * 60 * 60 * 1000) },
        ],
        nextId: 1,
        workerResponse: { success: true, response: 'VEREDITO: CONSISTENTE', attempts: 1, model: 'test' },
      }

      const pool = createMockPool(state)
      // Primeiro call falha, segundo succeeds
      const executeTaskMock = vi.fn()
        .mockRejectedValueOnce(new Error('model timeout'))
        .mockResolvedValueOnce({ success: true, response: 'VEREDITO: CONSISTENTE', attempts: 1, model: 'test' })
      const worker = { executeTask: executeTaskMock } as any
      const prompts = createMockPromptResolver()
      const events = createMockEvents()
      const notifier = createMockNotifier()
      const logger = createMockLogger()

      const verifier = new PostDeployVerifier(pool, worker, prompts, events, notifier, logger)
      await verifier.bootScan()

      // Ambos devem ter sido reivindicados
      expect(state.verifications).toHaveLength(2)
      const failRow = state.verifications.find(v => v.batch_id === 'batch-fail')
      const okRow = state.verifications.find(v => v.batch_id === 'batch-ok')
      expect(failRow?.status).toBe('failed')
      expect(okRow?.status).toBe('consistent')
    })
  })
})
