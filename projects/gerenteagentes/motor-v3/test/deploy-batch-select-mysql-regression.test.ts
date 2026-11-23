// @vitest-environment node
import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OperationLogEntry } from '../src/commands/index.js'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { DeployRepository } from '../src/deploy/DeployRepository.js'
import { RemoteBlueGreenDeployer } from '../src/deploy/RemoteBlueGreenDeployer.js'
import { createQueueMessage } from '../src/queue/QueueMessage.js'
import {
  applyScratchSchema,
  createScratchDatabase,
  createScratchPool,
  dropScratchDatabase,
  resolveMotorMySqlEnv,
} from './mysql-regression-support.js'
import type { Connection } from 'mysql2/promise'

const execFileAsync = promisify(execFile)

/**
 * Subtarefa 4 — motor-deploy-reconcile-hardening: regressão contra MySQL REAL.
 *
 * (A) batchSelect (DeployRepository.runningBatches / findPendingBatchByGateJob)
 *     executa contra o JOIN real deploy_batches x deploy_requests x tarefas x
 *     projeto_motor_config sem o erro "Column 'status' in where clause is
 *     ambiguous" (regressão do fix 58cdc18d): o schema scratch preserva as
 *     colunas homônimas `status` e o teste de mutação prova que a variante SEM
 *     o prefixo `db.` quebra exatamente com esse erro — ou seja, se o prefixo
 *     for removido do código, (A1) falha alto.
 * (B) Cenário do incidente (batch `running` + status remoto `success` +
 *     callback perdido) é recuperado SOZINHO em ≤1 ciclo do reconciliador:
 *     requestReconciliation() -> DEPLOY_RECONCILIATION_REQUESTED no outbox ->
 *     handle() da mensagem gerada -> batch `succeeded` e deploy_requests
 *     atualizados, sem intervenção manual e sem bloqueios.
 *
 * Ambiente: database scratch isolada (`motor_v3_scratch<char>`), nunca a base
 * de produção do motor; falha alto (sem skip) quando o MySQL não está
 * disponível. O status remoto é um arquivo temporário LOCAL em /tmp lido pela
 * RemoteBlueGreenDeployer real — apenas o transporte ssh() é redirecionado
 * para `bash -c` local; todo o parsing de status() permanece production code.
 */

const env = resolveMotorMySqlEnv()

function captureLogger() {
  const entries: OperationLogEntry[] = []
  const logger = { async append(entry: OperationLogEntry) { entries.push(entry) } }
  return { logger, entries }
}

/** Envolve o pool registrando o SQL exercitado (inspeção exigida pelo aceite 1). */
function recordingPool(inner: Pool): { pool: Pool; executed: string[] } {
  const executed: string[] = []
  const pool = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'query' && typeof value === 'function') {
        return (...args: unknown[]) => {
          executed.push(String(args[0]))
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  })
  return { pool, executed }
}

/**
 * RemoteBlueGreenDeployer real com o transporte ssh() redirecionado para bash
 * local: os arquivos /tmp/biblioteca-global-*.status são lidos pelo MESMO
 * status() de produção (validação de caminho, kill -0 no pid, parsing
 * process=/status=/log= e limites de diagnóstico).
 */
function localTransportDeployer(): RemoteBlueGreenDeployer {
  const deployer = new RemoteBlueGreenDeployer('local-bash')
  const transport = deployer as unknown as { ssh: (command: string) => Promise<{ stdout: string; stderr: string }> }
  transport.ssh = async (command: string) => {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], { encoding: 'utf8', timeout: 15_000 })
    return { stdout, stderr }
  }
  return deployer
}

describe('batchSelect contra MySQL real — regressão da ambiguidade de `status` (fix 58cdc18d)', () => {
  let admin: Connection
  let database: string
  let pool: Pool

  beforeAll(async () => {
    const scratch = await createScratchDatabase(env)
    admin = scratch.admin
    database = scratch.database
    pool = createScratchPool(env, database)
    await applyScratchSchema(pool)
    // Config do projeto + 2 tarefas + requests (running vinculado ao batch e pending)
    // + batches (running / pending com gate_job_id / succeeded): o JOIN do
    // batchSelect precisa encontrar linhas reais nas 4 tabelas.
    await pool.query(
      `INSERT INTO projeto_motor_config
         (projeto_id,repo_path,branch_trabalho,build_command,unit_test_command,project_layout,repo_path_host,git_remote,deploy_kind,deploy_script)
       VALUES (7,'/repo/regressao','base-desenvolvimento','npm run build','npm test','monorepo','/host/repo/regressao','git@github.com:regressao/repo.git','blue-green-api','deploy.sh')`,
    )
    const [taskA] = await pool.query<ResultSetHeader>(
      `INSERT INTO tarefas (projeto_id,titulo,external_id,tipo) VALUES (7,'Tarefa com batch running','task-regressao-a1','desenvolvimento')`,
    )
    const [taskB] = await pool.query<ResultSetHeader>(
      `INSERT INTO tarefas (projeto_id,titulo,external_id,tipo) VALUES (7,'Tarefa com batch pending','task-regressao-a2','desenvolvimento')`,
    )
    await pool.query(
      `INSERT INTO deploy_requests (tarefa_id,repo_path,requested_commit,base_branch,status,batch_id,started_at)
       VALUES (?, '/repo/regressao','abc1234567890','base-desenvolvimento','running','batch-regressao-running',NOW())`,
      [taskA.insertId],
    )
    await pool.query(
      `INSERT INTO deploy_requests (tarefa_id,repo_path,requested_commit,base_branch,status)
       VALUES (?, '/repo/regressao','def1234567890','base-desenvolvimento','pending')`,
      [taskB.insertId],
    )
    await pool.query(
      `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,started_at)
       VALUES ('batch-regressao-running','/repo/regressao','base-desenvolvimento','abc1234567890','running',NOW())`,
    )
    await pool.query(
      `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,gate_job_id)
       VALUES ('batch-regressao-pending','/repo/regressao','base-desenvolvimento','def1234567890','pending',9101)`,
    )
    await pool.query(
      `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,started_at,finished_at)
       VALUES ('batch-regressao-done','/repo/regressao','base-desenvolvimento','9991234567890','succeeded',NOW(),NOW())`,
    )
  }, 60_000)

  afterAll(async () => {
    if (pool) await pool.end().catch(() => undefined)
    if (admin && database) await dropScratchDatabase(admin, database).catch(() => undefined)
  })

  it('runningBatches() mapeia o batch running pelo JOIN real, sem erro de coluna ambígua', async () => {
    const { pool: recorded, executed } = recordingPool(pool)
    const repository = new DeployRepository(recorded, '/tmp/motor-regressao-1549-worktrees')

    const batches = await repository.runningBatches()

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      batchId: 'batch-regressao-running',
      repoPath: '/repo/regressao',
      baseBranch: 'base-desenvolvimento',
      expectedCommit: 'abc1234567890',
      status: 'running',
      gateJobId: null,
      // colunas do projeto_motor_config via JOIN tarefas->deploy_requests:
      projectLayout: 'monorepo',
      repoPathHost: '/host/repo/regressao',
      gitRemote: 'git@github.com:regressao/repo.git',
      deployKind: 'blue-green-api',
      deployScript: 'deploy.sh',
    })
    // Inspeção do SQL exercitado (aceite 1): a condição usa SEMPRE o prefixo db.
    const selectSql = executed.find(sql => sql.includes('FROM deploy_batches db'))
    expect(selectSql).toBeDefined()
    expect(selectSql).toContain("WHERE db.status='running' ORDER BY db.started_at")
    expect(selectSql).not.toMatch(/WHERE\s+status\s*=/)
    expect(selectSql).not.toMatch(/[^.]status\s*=\s*'/)
  }, 30_000)

  it('findPendingBatchByGateJob() localiza o batch pending pelo gate e retorna null para gate desconhecido', async () => {
    const { pool: recorded, executed } = recordingPool(pool)
    const repository = new DeployRepository(recorded, '/tmp/motor-regressao-1549-worktrees')

    const pending = await repository.findPendingBatchByGateJob(9101)
    expect(pending).toMatchObject({ batchId: 'batch-regressao-pending', status: 'pending', gateJobId: 9101 })

    const unknown = await repository.findPendingBatchByGateJob(1234)
    expect(unknown).toBeNull()

    const selectSql = executed.find(sql => sql.includes('FROM deploy_batches db'))
    expect(selectSql).toBeDefined()
    expect(selectSql).toContain("WHERE db.gate_job_id=? AND db.status='pending' LIMIT 1")
  }, 30_000)

  it('mutação: a mesma consulta SEM o prefixo db. falha com "Column \'status\' ... is ambiguous" (prova da fidelidade do schema)', async () => {
    // Se alguém reintroduzir `status` sem prefixo no batchSelect, runningBatches()
    // quebra exatamente assim — o schema scratch reproduz a homonímia real
    // (deploy_batches.status x deploy_requests.status).
    const ambiguousSelect = `SELECT db.batch_id,db.status
      FROM deploy_batches db
      LEFT JOIN deploy_requests dr ON dr.batch_id=db.batch_id
      LEFT JOIN tarefas t ON t.id=dr.tarefa_id
      LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
      WHERE status='running' ORDER BY db.started_at`
    await expect(pool.query(ambiguousSelect)).rejects.toThrow(/ambiguous/i)
    try {
      await pool.query(ambiguousSelect)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ER_NON_UNIQ_ERROR')
    }
  }, 30_000)
})

describe('cenário do incidente contra MySQL real — batch running + status remoto success + callback perdido recuperado em ≤1 ciclo', () => {
  const batchId = 'deploy-regressao-1549'
  const statusPath = `/tmp/biblioteca-global-${batchId}.status`
  const externalTaskId = 'task-regressao-incidente-1549'

  let admin: Connection
  let database: string
  let pool: Pool

  beforeAll(async () => {
    const scratch = await createScratchDatabase(env)
    admin = scratch.admin
    database = scratch.database
    pool = createScratchPool(env, database)
    await applyScratchSchema(pool)
    // Estado do incidente: batch `running` iniciado agora (dentro do timeout),
    // deploy_request `running` vinculado, lock adquirido pelo batch e marcador
    // remoto local com `success` — mas NENHUM callback recebido (sem
    // DEPLOY_BATCH_RESULT_RECEIVED no outbox).
    await pool.query(
      `INSERT INTO projeto_motor_config (projeto_id,repo_path,branch_trabalho,build_command,unit_test_command)
       VALUES (9,'/repo/incidente','base-desenvolvimento','npm run build','npm test')`,
    )
    const [task] = await pool.query<ResultSetHeader>(
      `INSERT INTO tarefas (projeto_id,titulo,external_id,tipo) VALUES (9,'Tarefa do incidente','${externalTaskId}','desenvolvimento')`,
    )
    await pool.query(
      `INSERT INTO deploy_requests (tarefa_id,repo_path,requested_commit,base_branch,status,batch_id,started_at)
       VALUES (?, '/repo/incidente','abc1234567890','base-desenvolvimento','running',?,NOW())`,
      [task.insertId, batchId],
    )
    await pool.query(
      `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,remote_pid,remote_status_path,started_at)
       VALUES (?, '/repo/incidente','base-desenvolvimento','abc1234567890','running','99999999',?,NOW())`,
      [batchId, statusPath],
    )
    await pool.query(
      `INSERT INTO motor_deploy_lock (id,locked,locked_at,locked_by,reason) VALUES (1,TRUE,NOW(),?,'dispatch')`,
      [batchId],
    )
    await writeFile(statusPath, 'success', 'utf8')
  }, 60_000)

  afterAll(async () => {
    await unlink(statusPath).catch(() => undefined)
    if (pool) await pool.end().catch(() => undefined)
    if (admin && database) await dropScratchDatabase(admin, database).catch(() => undefined)
  })

  it('requestReconciliation + handle da mensagem gerada finalizam o batch como succeeded sem intervenção manual', async () => {
    const { logger, entries } = captureLogger()
    const repository = new DeployRepository(pool, '/tmp/motor-regressao-1549-worktrees')
    const consumer = new DeployConsumer(repository, {} as never, localTransportDeployer(), logger)

    // Ciclo 1 do reconciliador: reenfileira a reconciliação do batch running.
    const enqueued = await consumer.requestReconciliation()
    expect(enqueued).toBe(1)

    const [outboxRows] = await pool.query<Array<RowDataPacket & {
      message_id: string; type: string; task_id: string; execution_id: string
      correlation_id: string | null; causation_id: string | null
      payload_json: unknown; status: string; deferred: number
    }>>(
      `SELECT message_id,type,task_id,execution_id,correlation_id,causation_id,payload_json,status,
              (timestamp > NOW()) AS deferred
         FROM motor_outbox WHERE type='DEPLOY_RECONCILIATION_REQUESTED'`,
    )
    expect(outboxRows).toHaveLength(1)
    const row = outboxRows[0]!
    expect(row.task_id).toBe('system')
    expect(row.status).toBe('pending')
    expect(Number(row.deferred)).toBe(1) // mensagem nasce adiada no outbox (retry)
    expect(row.correlation_id).toMatch(new RegExp(`^deploy-reconcile-cycle-${batchId}-\\d{13}$`))
    const payload = (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) as { batchId?: string }
    expect(payload.batchId).toBe(batchId)

    // Entrega a mensagem gerada ao consumidor (papel do OutboxPublisher/QueueConsumer).
    const message = createQueueMessage({
      type: row.type,
      taskId: row.task_id,
      executionId: row.execution_id,
      messageId: row.message_id,
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
      payload,
    })
    await consumer.handle(message)

    // Batch finalizado como succeeded pelo reconcile (leitura real do marcador).
    const [batchRows] = await pool.query<Array<RowDataPacket & { status: string; last_error: string | null; finished_at: Date | null }>>(
      `SELECT status,last_error,finished_at FROM deploy_batches WHERE batch_id=?`, [batchId],
    )
    expect(batchRows[0]?.status).toBe('succeeded')
    expect(batchRows[0]?.last_error).toBeNull()
    expect(batchRows[0]?.finished_at).not.toBeNull()

    // deploy_requests atualizado na mesma transação.
    const [requestRows] = await pool.query<Array<RowDataPacket & { status: string; finished_at: Date | null }>>(
      `SELECT status,finished_at FROM deploy_requests WHERE batch_id=?`, [batchId],
    )
    expect(requestRows).toHaveLength(1)
    expect(requestRows[0]?.status).toBe('succeeded')
    expect(requestRows[0]?.finished_at).not.toBeNull()

    // Eventos canônicos no outbox: DEPLOY_BATCH_SUCCEEDED + TASK_DEPLOYED da tarefa.
    const [eventRows] = await pool.query<Array<RowDataPacket & { type: string; task_id: string }>>(
      `SELECT type,task_id FROM motor_outbox ORDER BY id`,
    )
    expect(eventRows.filter(event => event.type === 'DEPLOY_BATCH_SUCCEEDED')).toHaveLength(1)
    expect(eventRows.some(event => event.type === 'TASK_DEPLOYED' && event.task_id === externalTaskId)).toBe(true)

    // Nenhuma intervenção manual: zero bloqueios e lock do deploy liberado.
    const [blockRows] = await pool.query<Array<RowDataPacket & { total: number }>>(`SELECT COUNT(*) AS total FROM bloqueios`)
    expect(Number(blockRows[0]?.total)).toBe(0)
    const [lockRows] = await pool.query<Array<RowDataPacket & { locked: number; locked_by: string | null }>>(
      `SELECT locked,locked_by FROM motor_deploy_lock WHERE id=1`,
    )
    expect(Number(lockRows[0]?.locked)).toBe(0)
    expect(lockRows[0]?.locked_by).toBeNull()

    // Log operacional da primitiva de finalização.
    expect(entries.some(entry => entry.actionCode === 'A32_RECONCILE_DEPLOY_BATCH' && entry.primitiveCode === 'complete_deploy_batch_atomic' && entry.outcome === 'succeeded')).toBe(true)

    // ≤1 ciclo: uma segunda entrega da mesma mensagem é inerte (idempotência do
    // completeBatch — o batch já não está pending/running) e não duplica eventos.
    await consumer.handle(createQueueMessage({ type: row.type, taskId: row.task_id, executionId: `${row.execution_id}-redelivery`, payload }))
    const [recountRows] = await pool.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM motor_outbox WHERE type IN ('DEPLOY_BATCH_SUCCEEDED','TASK_DEPLOYED')`,
    )
    expect(Number(recountRows[0]?.total)).toBe(2)
    const [batchAfter] = await pool.query<Array<RowDataPacket & { status: string }>>(
      `SELECT status FROM deploy_batches WHERE batch_id=?`, [batchId],
    )
    expect(batchAfter[0]?.status).toBe('succeeded')
  }, 60_000)
})
