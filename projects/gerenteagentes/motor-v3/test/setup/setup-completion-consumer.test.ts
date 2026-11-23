// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createQueueMessage } from '../../src/queue/index.js'
import {
  SetupCompletionConsumer,
  SMOKE_TEST_EVIDENCE_SCHEMA_TEXT,
  buildSmokeTestEvidenceGuidance,
  hasValidSmokeTest,
  parseJsonObjectCandidates,
  reconcileSetupCompletion,
  setupReconciliationMarker,
} from '../../src/setup/SetupCompletionConsumer.js'
import { SetupCompletionSweeper } from '../../src/setup/SetupCompletionSweeper.js'
import { deriveSetupChecklist } from '../../src/setup/ProjectSetupGate.js'
import type { TaskEventSink } from '../../src/coordinator/TaskEventRecorder.js'

/**
 * task-p2-1072 (subtarefa 2) — regressão da reconciliação de setup_status na
 * conclusão de tarefa setup-* por fluxo de desenvolvimento.
 *
 * Caso real (2026-11-14): setup-gestao-de-tarefas-global (1020) terminou
 * completed com 4/4 subtarefas verified, mas projetos_captados.setup_status
 * permaneceu 'queued'; a tarefa dependente (1063) falhou no preflight por
 * docs/CONTEXTO-ANALISTA.md ausente.
 *
 * Cenários cobertos (fakes de pool/fs seguindo os testes existentes —
 * padrão setup-verification-artifact-gate.test.ts):
 * 1. conclusão dev com artefatos + smoke válidos → verified com evidência;
 * 2. artefato ausente → failed com setup_error explícito (nunca 'queued');
 * 3. já verified → no-op auditado (redelivery não duplica efeitos);
 * 4. nenhuma evidência smoke_test válida → failed com razão explícita;
 * 5. varredura (sweeper) reconcilia completed+queued com a MESMA função;
 * 6. mensagens que não são de tarefa setup ou não são TASK_EXECUTION_COMPLETED
 *    são ignoradas.
 */

const SLUG = 'gestao-de-tarefas-global'
const EXTERNAL_ID = `setup-${SLUG}`
const DB_TASK_ID = 1020

const validEvidence = {
  checklist: { structure: true, configSchemaMigrations: true, registries: true, repoPath: true },
  smoke_test: { url: 'http://localhost:3000/api/demo/', method: 'GET', status: 200, response_body: '{}', timestamp: '2026-11-14T00:00:00.000Z' },
}

interface Recorded {
  sql: string
  params: unknown[]
}

interface FakePoolState {
  projectStatus: string
  repoPath: string | null
  projectLayout?: 'monorepo' | 'standalone' | null
  resultados: Array<string | null>
  sweeperRows: Array<{ id: number; external_id: string }>
  chatAffectedRows: number
  failAllQueries?: boolean
}

function createFakePool(state: FakePoolState) {
  const updates: Recorded[] = []
  const chats: Recorded[] = []
  const sweeperSelects: Recorded[] = []
  const events: Array<{ taskId: string; evento: string; payload: Record<string, unknown> | null }> = []
  const taskEvents: TaskEventSink = {
    record: vi.fn(async (taskId: string, evento: string, _ator?: string, payload?: Record<string, unknown> | null) => {
      events.push({ taskId, evento, payload: payload ?? null })
    }),
  }
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (state.failAllQueries) throw new Error('db offline')
      if (sql.includes('FROM projetos_captados WHERE slug')) {
        return [[{ id: 6, setup_status: state.projectStatus }], []]
      }
      if (sql.includes('LEFT JOIN projeto_motor_config') && sql.includes('FROM tarefas t')) {
        return [[{ id: DB_TASK_ID, external_id: EXTERNAL_ID, repo_path: state.repoPath, project_layout: state.projectLayout ?? null }], []]
      }
      if (sql.includes('FROM subtarefas s')) {
        return [state.resultados.map(resultado => ({ resultado })), []]
      }
      if (sql.includes("SET setup_status='verified'")) {
        updates.push({ sql, params })
        state.projectStatus = 'verified'
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes("SET setup_status='failed'")) {
        updates.push({ sql, params })
        state.projectStatus = 'failed'
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes('INSERT INTO tarefa_chats')) {
        chats.push({ sql, params })
        return [{ affectedRows: state.chatAffectedRows, insertId: 55 }, []]
      }
      if (sql.includes('SUBSTRING(t.external_id') && sql.includes('task_runtime_facts')) {
        sweeperSelects.push({ sql, params })
        return [state.sweeperRows, []]
      }
      return [[], []]
    }),
  }
  return { pool: pool as never, updates, chats, sweeperSelects, events, taskEvents }
}

function completionMessage(taskId = EXTERNAL_ID) {
  return createQueueMessage({
    type: 'TASK_EXECUTION_COMPLETED',
    taskId,
    executionId: `exec-${taskId}`,
    payload: { integrationCommitSha: 'abc123' },
  })
}

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** Cria um repo temporário `projects/<slug>` com ou sem o artefato obrigatório. */
async function makeRepo(withArtifact: boolean): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'setup-completion-repo-'))
  tempDirs.push(repoRoot)
  const projectDir = join(repoRoot, 'projects', SLUG)
  await mkdir(join(projectDir, 'docs'), { recursive: true })
  if (withArtifact) {
    await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto do Analista\n')
  }
  return repoRoot
}

function defaultState(overrides: Partial<FakePoolState> = {}): FakePoolState {
  return {
    projectStatus: 'queued',
    repoPath: null,
    resultados: [JSON.stringify(validEvidence)],
    sweeperRows: [],
    chatAffectedRows: 1,
    ...overrides,
  }
}

describe('SetupCompletionConsumer — reconciliação na conclusão por fluxo de desenvolvimento', () => {
  it('artefatos + smoke válidos → setup_status=verified com evidência (smoke_test + artefatos + origem development_flow)', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({ repoPath: repoRoot }))
    const consumer = new SetupCompletionConsumer(fake.pool, fake.taskEvents)

    await consumer.handle(completionMessage())

    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    expect(verified[0].params[1]).toBe(SLUG)
    const evidence = JSON.parse(String(verified[0].params[0]))
    expect(evidence.smoke_test).toEqual(validEvidence.smoke_test)
    expect(evidence.checklist).toEqual(validEvidence.checklist)
    expect(evidence.artifacts).toEqual(['docs/CONTEXTO-ANALISTA.md'])
    expect(evidence.origin).toBe('development_flow')
    expect(evidence.reconciled_by).toBe('task_execution_completed')
    expect(fake.updates.some(u => u.sql.includes("setup_status='failed'"))).toBe(false)

    // Auditoria + alerta legível idempotente no chat da tarefa de setup.
    expect(fake.events).toContainEqual({
      taskId: EXTERNAL_ID,
      evento: 'setup_reconciled',
      payload: expect.objectContaining({ outcome: 'verified', slug: SLUG, origin: 'task_execution_completed' }),
    })
    expect(fake.chats).toHaveLength(1)
    expect(String(fake.chats[0].params[3])).toContain(`%${setupReconciliationMarker(SLUG, 'verified')}%`)
    expect(String(fake.chats[0].params[1])).toContain('Setup do projeto verificado')
  })

  it('artefato ausente → setup_status=failed com setup_error explícito (nunca permanece queued)', async () => {
    const repoRoot = await makeRepo(false)
    const fake = createFakePool(defaultState({ repoPath: repoRoot }))
    const consumer = new SetupCompletionConsumer(fake.pool, fake.taskEvents)

    await consumer.handle(completionMessage())

    expect(fake.updates.some(u => u.sql.includes("setup_status='verified'"))).toBe(false)
    const failed = fake.updates.filter(u => u.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    expect(failed[0].params[1]).toBe(SLUG)
    expect(fake.events).toContainEqual({
      taskId: EXTERNAL_ID,
      evento: 'setup_reconciled',
      payload: expect.objectContaining({ outcome: 'failed', slug: SLUG }),
    })
    expect(fake.chats).toHaveLength(1)
    expect(String(fake.chats[0].params[1])).toContain('Setup reprovado na reconciliação de conclusão')
    expect(String(fake.chats[0].params[1])).toContain('docs/CONTEXTO-ANALISTA.md')
  })

  it('já verified → no-op auditado (redelivery não duplica efeitos)', async () => {
    const fake = createFakePool(defaultState({ projectStatus: 'verified' }))
    const consumer = new SetupCompletionConsumer(fake.pool, fake.taskEvents)

    await consumer.handle(completionMessage())
    await consumer.handle(completionMessage()) // redelivery

    expect(fake.updates).toHaveLength(0)
    expect(fake.chats).toHaveLength(0)
    expect(fake.events).toHaveLength(2)
    for (const event of fake.events) {
      expect(event.evento).toBe('setup_reconciliation_skipped')
      expect(event.payload).toEqual(expect.objectContaining({ outcome: 'skipped_already_verified', slug: SLUG }))
    }
  })

  it('nenhuma evidência smoke_test válida em subtarefas.resultado → failed com razão explícita', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({
      repoPath: repoRoot,
      resultados: ['não é JSON', JSON.stringify({ sem: 'smoke' }), JSON.stringify({ smoke_test: { url: 'x', method: 'GET', status: 500, timestamp: '2026-11-14T00:00:00.000Z' } })],
    }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    const failed = fake.updates.filter(u => u.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('nenhum resultado de subtarefa verified com evidência smoke_test JSON válida')
    expect(result.outcome === 'failed' && result.reasons.some(r => r.includes('nenhum resultado de subtarefa verified'))).toBe(true)
  })

  it('aceita o PRIMEIRO JSON com smoke_test válido, ignorando resultados anteriores inválidos', async () => {
    const repoRoot = await makeRepo(true)
    const second = { ...validEvidence, smoke_test: { ...validEvidence.smoke_test, url: 'http://localhost:3000/api/segunda/' } }
    const fake = createFakePool(defaultState({
      repoPath: repoRoot,
      resultados: ['texto livre do DEV', JSON.stringify({ smoke_test: { url: 'x', method: 'GET', status: 503, timestamp: '2026-11-14T00:00:00.000Z' } }), JSON.stringify(second)],
    }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    expect(JSON.parse(String(verified[0].params[0])).smoke_test.url).toBe('http://localhost:3000/api/segunda/')
  })

  it('repo_path ausente → failed com erro explícito (impossível validar artefatos)', async () => {
    const fake = createFakePool(defaultState({ repoPath: null }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reasons.some(r => r.includes(`repo_path do projeto ausente para slug '${SLUG}'`))).toBe(true)
    expect(fake.updates.some(u => u.sql.includes("setup_status='failed'"))).toBe(true)
  })

  it('ignora mensagens que não são TASK_EXECUTION_COMPLETED de tarefa setup-*', async () => {
    const fake = createFakePool(defaultState())
    const consumer = new SetupCompletionConsumer(fake.pool, fake.taskEvents)

    await consumer.handle(createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: EXTERNAL_ID, executionId: 'e1', payload: {} }))
    await consumer.handle(createQueueMessage({ type: 'TASK_EXECUTION_COMPLETED', taskId: 'task-p2-1072', executionId: 'e2', payload: {} }))

    expect(fake.pool.query).not.toHaveBeenCalled()
    expect(fake.updates).toHaveLength(0)
  })

  it('chat já existente (marcador presente) → deduplicado sem erro; alerta best-effort não derruba a reconciliação', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({ repoPath: repoRoot, chatAffectedRows: 0 }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    expect(fake.chats).toHaveLength(1) // INSERT ... WHERE NOT EXISTS executado; affectedRows=0 → deduplicado
  })
})

describe('SetupCompletionSweeper — rede de segurança durável (boot + periódica)', () => {
  it('reconcilia tarefa setup-* completed com projeto ainda queued (MESMA função de reconciliação)', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({
      repoPath: repoRoot,
      sweeperRows: [{ id: DB_TASK_ID, external_id: EXTERNAL_ID }],
    }))
    const sweeper = new SetupCompletionSweeper(fake.pool, { taskEvents: fake.taskEvents, intervalMs: 60000 })

    const results = await sweeper.reconcile('boot_sweep')

    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    expect(JSON.parse(String(verified[0].params[0])).reconciled_by).toBe('boot_sweep')
  })

  it('passivo histórico (caso 1020): completed + queued + artefato ausente → failed explícito', async () => {
    const repoRoot = await makeRepo(false)
    const fake = createFakePool(defaultState({
      repoPath: repoRoot,
      sweeperRows: [{ id: DB_TASK_ID, external_id: EXTERNAL_ID }],
    }))
    const sweeper = new SetupCompletionSweeper(fake.pool, { taskEvents: fake.taskEvents, intervalMs: 60000 })

    const results = await sweeper.reconcile('boot_sweep')

    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('failed')
    const failed = fake.updates.filter(u => u.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
  })

  it('barreira de erro: falha de banco não propaga (próxima passagem tenta de novo)', async () => {
    const fake = createFakePool(defaultState({ failAllQueries: true }))
    const sweeper = new SetupCompletionSweeper(fake.pool, { taskEvents: fake.taskEvents, intervalMs: 60000 })

    await expect(sweeper.reconcile('boot_sweep')).resolves.toEqual([])
  })

  it('setup failed volta à varredura com cooldown (reprovação pré-deploy não é permanente)', async () => {
    // Incidente 2026-11-21: a reconciliação da conclusão roda antes do deploy
    // materializar os artefatos na base; sem retentativa, o 'failed' virava
    // permanente (casos reais: gerenteagentes, voz-na-isa, calculadora).
    const fake = createFakePool(defaultState())
    const sweeper = new SetupCompletionSweeper(fake.pool, { intervalMs: 60000 })

    await sweeper.reconcile('boot_sweep')

    expect(fake.sweeperSelects).toHaveLength(1)
    const sql = fake.sweeperSelects[0].sql
    expect(sql).toContain("pc.setup_status = 'failed'")
    expect(sql).toMatch(/INTERVAL\s+15\s+MINUTE/)
    expect(sql).toContain('pc.updated_at <')
  })

  it('setup failed com artefatos + evidência válidos → re-reconciliado para verified', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({
      projectStatus: 'failed',
      repoPath: repoRoot,
      sweeperRows: [{ id: DB_TASK_ID, external_id: EXTERNAL_ID }],
    }))
    const sweeper = new SetupCompletionSweeper(fake.pool, { taskEvents: fake.taskEvents, intervalMs: 60000 })

    const results = await sweeper.reconcile('periodic_sweep')

    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
  })

  it('start/stop controlam o timer periódico sem vazar handles', async () => {
    const fake = createFakePool(defaultState())
    const sweeper = new SetupCompletionSweeper(fake.pool, { intervalMs: 60000 })
    sweeper.start()
    sweeper.start() // segunda chamada é no-op
    sweeper.stop()
    sweeper.stop() // idempotente
    expect(true).toBe(true)
  })
})

describe('hasValidSmokeTest — predicado de evidência', () => {
  it('aceita smoke_test 2xx completo e rejeita inválidos', () => {
    expect(hasValidSmokeTest(validEvidence.smoke_test)).toBe(true)
    expect(hasValidSmokeTest({ ...validEvidence.smoke_test, status: 500 })).toBe(false)
    expect(hasValidSmokeTest({ ...validEvidence.smoke_test, status: 200.5 })).toBe(false)
    expect(hasValidSmokeTest({ ...validEvidence.smoke_test, timestamp: 'não é data' })).toBe(false)
    expect(hasValidSmokeTest({ ...validEvidence.smoke_test, url: '' })).toBe(false)
    expect(hasValidSmokeTest(null)).toBe(false)
    expect(hasValidSmokeTest('200')).toBe(false)
  })
})

/**
 * Incidente b3517 (2026-11-20, setup-calculadora-de-investimentos-gabriel):
 * a última subtarefa de setup é external_operation — o WorkerLauncher exige
 * rótulos "O que foi feito:"/"Como verificar:" + ::DONE::, então
 * subtarefas.resultado nunca é JSON puro nesse fluxo. A reconciliação antiga
 * (JSON.parse do texto integral) reprovava o setup mesmo com o smoke test
 * executado (caso real: setup-gerenteagentes, subtarefa 1553). A extração
 * tolerante aceita o JSON embutido sem afrouxar o gate: o candidato precisa
 * ter smoke_test válido.
 */
describe('reconcileSetupCompletion — evidência JSON embutida em resposta external_operation', () => {
  it('resposta real do protocolo (rótulos + ::DONE:: + JSON no fim) → verified com a evidência extraída', async () => {
    const repoRoot = await makeRepo(true)
    const respostaDev = [
      'O que foi feito: provisionado o banco projeto_640 e executado smoke test autenticado com status 200.',
      'Como verificar: GET http://localhost:3000/api/demo/ com token de projeto → 200; banco projeto_640 existe no MySQL.',
      '::DONE::',
      JSON.stringify(validEvidence),
    ].join('\n')
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [respostaDev] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    const evidence = JSON.parse(String(verified[0].params[0]))
    expect(evidence.smoke_test).toEqual(validEvidence.smoke_test)
    expect(evidence.origin).toBe('development_flow')
  })

  it('formato do incidente 1553 (::DONE:: antes dos rótulos, JSON no fim) → verified', async () => {
    const repoRoot = await makeRepo(true)
    const respostaDev = `::DONE::\nO que foi feito: Provisionado banco projeto_640 e realizado smoke test funcional com evidência\nComo verificar:\n1. Query information_schema → banco existe\n2. GET autenticado → 200\n${JSON.stringify(validEvidence)}`
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [respostaDev] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
  })

  it('prosa rotulada SEM bloco JSON continua reprovando (gate não foi afrouxado)', async () => {
    const repoRoot = await makeRepo(true)
    const respostaDev = 'O que foi feito: provisionei o banco e rodei curl 200.\nComo verificar: rode o curl de novo.\n::DONE::'
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [respostaDev] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reasons.some(r => r.includes('nenhum resultado de subtarefa verified'))).toBe(true)
  })

  it('JSON embutido com smoke_test inválido é ignorado; bloco válido posterior é escolhido', async () => {
    const repoRoot = await makeRepo(true)
    const invalido = JSON.stringify({ smoke_test: { url: 'x', method: 'GET', status: 503, timestamp: '2026-11-14T00:00:00.000Z' } })
    const respostaDev = `O que foi feito: tentei duas vezes.\nComo verificar: veja os blocos.\n::DONE::\n${invalido}\ne depois\n${JSON.stringify(validEvidence)}`
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [respostaDev] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(JSON.parse(String(verified[0].params[0])).smoke_test.status).toBe(200)
  })
})

/**
 * Incidente 1 (19/11, projetos 13 e 2/tarefa 1101): o smoke test foi executado mas o
 * resultado foi gravado em prosa → setup reprovado por evidência inválida e o DEV
 * não recebeu o formato aceito. A reprovação por evidência agora inclui no
 * setup_error e no alerta do chat o schema JSON exato + regras + auto-checagem.
 * A lógica de aceitação/rejeição do gate permanece idêntica.
 */
describe('reprovação por evidência smoke_test — setup_error e alerta contêm o schema JSON esperado', () => {
  it('reprovação "nenhum resultado verified com evidência smoke_test JSON válida" grava setup_error com o schema literal', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: ['prosa do DEV com curl e ::DONE:: sem JSON'] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    const failed = fake.updates.filter(u => u.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    const setupError = String(failed[0].params[0])
    expect(setupError).toContain('nenhum resultado de subtarefa verified com evidência smoke_test JSON válida')
    // Schema exato aceito, literal no setup_error.
    expect(setupError).toContain('{"smoke_test":{"url"')
    for (const key of ['"url"', '"method"', '"status"', '"response_body"', '"timestamp"']) {
      expect(setupError).toContain(key)
    }
    // Regras e aviso de reprovação por prosa.
    expect(setupError).toContain('2xx')
    expect(setupError).toContain('ISO')
    expect(setupError).toContain('REPROVA o setup')
    // Auto-checagem pronta para o DEV.
    expect(setupError).toContain('jq -e')
  })

  it('alerta no chat da reprovação por evidência contém o schema JSON e a instrução anti-prosa', async () => {
    const repoRoot = await makeRepo(true)
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: ['apenas texto'] }))

    await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(fake.chats).toHaveLength(1)
    const chatText = String(fake.chats[0].params[1])
    expect(chatText).toContain('Setup reprovado na reconciliação de conclusão')
    expect(chatText).toContain('Evidência smoke_test — formato obrigatório')
    expect(chatText).toContain('{"smoke_test":{"url"')
    expect(chatText).toContain('REPROVA o setup')
  })

  it('reprovação apenas por artefato ausente (evidência válida) NÃO acresce o bloco de schema ao setup_error', async () => {
    const repoRoot = await makeRepo(false)
    const fake = createFakePool(defaultState({ repoPath: repoRoot }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'task_execution_completed', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    const failed = fake.updates.filter(u => u.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    expect(String(failed[0].params[0])).not.toContain('smoke_test')
    expect(String(fake.chats[0].params[1])).not.toContain('formato obrigatório')
  })

  it('guidance: schema literal é JSON parseável com as chaves exigidas e o gate continua aceitando apenas o mesmo formato', () => {
    const guidance = buildSmokeTestEvidenceGuidance()
    const schemaLine = guidance.split('\n')[0]
    const schemaJson = JSON.parse(schemaLine.slice(schemaLine.indexOf('{"smoke_test"')))
    expect(Object.keys(schemaJson)).toEqual(['smoke_test'])
    expect(Object.keys(schemaJson.smoke_test).sort()).toEqual(['method', 'response_body', 'status', 'timestamp', 'url'])
    // Gate inalterado: mesmo predicado de sempre.
    expect(hasValidSmokeTest(validEvidence.smoke_test)).toBe(true)
    expect(SMOKE_TEST_EVIDENCE_SCHEMA_TEXT.startsWith('{"smoke_test":{')).toBe(true)
  })
})

describe('parseJsonObjectCandidates — extração tolerante de JSON', () => {
  it('texto integral JSON puro → candidato único (comportamento anterior preservado)', () => {
    const candidates = parseJsonObjectCandidates(JSON.stringify(validEvidence))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual(validEvidence)
  })

  it('blocos balanceados em ordem de aparição; chaves dentro de strings não quebram o scanner', () => {
    const texto = 'prefixo {inválido} meio\n{"a":"tem } e { na string","b":1}\nfim {"c":2}'
    const candidates = parseJsonObjectCandidates(texto)
    expect(candidates).toEqual([{ a: 'tem } e { na string', b: 1 }, { c: 2 }])
  })

  it('escapes dentro de strings são respeitados', () => {
    const candidates = parseJsonObjectCandidates('x\n{"msg":"aspas \\" e chave }","ok":true}')
    expect(candidates).toEqual([{ msg: 'aspas " e chave }', ok: true }])
  })

  it('arrays e scalars não são candidatos; vazio/null → lista vazia', () => {
    expect(parseJsonObjectCandidates('[1,2,3]')).toEqual([])
    expect(parseJsonObjectCandidates('42')).toEqual([])
    expect(parseJsonObjectCandidates('')).toEqual([])
    expect(parseJsonObjectCandidates(null)).toEqual([])
    expect(parseJsonObjectCandidates(undefined)).toEqual([])
  })

  it('respeita teto de tentativas em texto patológico (muitas chaves desbalanceadas)', () => {
    const texto = '{'.repeat(5000)
    const candidates = parseJsonObjectCandidates(texto)
    expect(candidates).toEqual([])
  })
})

describe('checklist derivado do disco — evidência histórica sem checklist (incidente 2026-11-23)', () => {
  const smokeOnlyEvidence = { smoke_test: validEvidence.smoke_test }

  /** Repo monorepo completo: package.json + config.ts + schema.ts + migrations/ + artefato. */
  async function makeFullRepo(files: {
    packageJson?: boolean
    configTs?: boolean
    schemaTs?: boolean
    migrations?: boolean
    artifact?: boolean
  } = {}): Promise<string> {
    const opts = { packageJson: true, configTs: true, schemaTs: true, migrations: true, artifact: true, ...files }
    const repoRoot = await mkdtemp(join(tmpdir(), 'setup-derived-checklist-'))
    tempDirs.push(repoRoot)
    const projectDir = join(repoRoot, 'projects', SLUG)
    await mkdir(join(projectDir, 'docs'), { recursive: true })
    if (opts.packageJson) await writeFile(join(projectDir, 'package.json'), '{"name":"x"}')
    if (opts.configTs) await writeFile(join(projectDir, 'config.ts'), 'export const config = {}')
    if (opts.schemaTs) await writeFile(join(projectDir, 'schema.ts'), 'export {}')
    if (opts.migrations) await mkdir(join(projectDir, 'migrations'), { recursive: true })
    if (opts.artifact) await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto\n')
    return repoRoot
  }

  it('deriveSetupChecklist — disco completo → todos os itens true; vazio → todos false', async () => {
    const full = await makeFullRepo()
    expect(await deriveSetupChecklist(join(full, 'projects', SLUG))).toEqual({
      structure: true, configSchemaMigrations: true, registries: true, repoPath: true,
    })
    const empty = await mkdtemp(join(tmpdir(), 'setup-derived-empty-'))
    tempDirs.push(empty)
    expect(await deriveSetupChecklist(empty)).toEqual({
      structure: false, configSchemaMigrations: false, registries: false, repoPath: true,
    })
    expect(await deriveSetupChecklist(join(empty, 'inexistente'))).toEqual({
      structure: false, configSchemaMigrations: false, registries: false, repoPath: false,
    })
  })

  it('evidência histórica (smoke_test válido SEM checklist) + disco completo → verified com checklist derivado e procedência auditável', async () => {
    const repoRoot = await makeFullRepo()
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [`Resumo do DEV\n${JSON.stringify(smokeOnlyEvidence)}`] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    const verified = fake.updates.filter(u => u.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    const evidence = JSON.parse(String(verified[0].params[0]))
    expect(evidence.checklist).toEqual({ structure: true, configSchemaMigrations: true, registries: true, repoPath: true })
    expect(evidence.checklist_source).toBe('derived_disk_verification')
    expect(evidence.smoke_test).toEqual(validEvidence.smoke_test)
  })

  it('evidência histórica + schema.ts ausente → failed honesto (checklist incompleto: configSchemaMigrations/registries)', async () => {
    const repoRoot = await makeFullRepo({ schemaTs: false })
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [JSON.stringify(smokeOnlyEvidence)] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reasons).toEqual(expect.arrayContaining([
      'checklist incompleto: configSchemaMigrations',
      'checklist incompleto: registries',
    ]))
  })

  it('evidência histórica + package.json ausente → failed (checklist incompleto: structure)', async () => {
    const repoRoot = await makeFullRepo({ packageJson: false })
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [JSON.stringify(smokeOnlyEvidence)] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reasons).toContain('checklist incompleto: structure')
  })

  it('sem smoke_test válido NÃO deriva checklist (voz-na-isa: smoke nunca executado → reprovação honesta preservada)', async () => {
    const repoRoot = await makeFullRepo()
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: ['O DEV disse que o smoke test é escopo da próxima subtarefa. ::DONE::'] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reasons.some(r => r.includes('nenhum resultado de subtarefa verified com evidência smoke_test JSON válida'))).toBe(true)
    expect(fake.updates.some(u => u.sql.includes("setup_status='verified'"))).toBe(false)
  })

  it('evidência COM checklist do DEV não é substituída pela derivação (autodeclaração continua valendo)', async () => {
    const repoRoot = await makeFullRepo({ schemaTs: false })
    const fake = createFakePool(defaultState({ repoPath: repoRoot, resultados: [JSON.stringify(validEvidence)] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('verified')
    const evidence = JSON.parse(String(fake.updates.filter(u => u.sql.includes("setup_status='verified'"))[0].params[0]))
    expect(evidence.checklist).toEqual(validEvidence.checklist)
    expect(evidence.checklist_source).toBeUndefined()
  })

  it('layout standalone sem checklist NÃO deriva (itens são julgamento do agente) → failed', async () => {
    const repoRoot = await makeFullRepo()
    const fake = createFakePool(defaultState({ repoPath: repoRoot, projectLayout: 'standalone', resultados: [JSON.stringify(smokeOnlyEvidence)] }))

    const result = await reconcileSetupCompletion(fake.pool, SLUG, { origin: 'periodic_sweep', taskEvents: fake.taskEvents })

    expect(result.outcome).toBe('failed')
    // standalone: repoPath vira a RAIZ do repo (sem /projects/<slug>) → artefato ausente + checklist ausente.
    expect(result.outcome === 'failed' && result.reasons).toContain('checklist ausente')
  })
})
