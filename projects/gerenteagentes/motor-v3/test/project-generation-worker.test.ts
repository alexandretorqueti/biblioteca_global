// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Pool, ResultSetHeader } from 'mysql2/promise'
import type { AnalystConsole, AnalystSession } from '../src/analysis/ConsoleAnalystRunner.js'
import {
  DEFAULT_GENERATION_MODEL_CHAIN,
  ManagedGenerationPromptResolver,
  ProjectGenerationWorker,
  isLocalModel,
  resolveGenerationModelChain,
  type GenerationPromptInput,
  type GenerationTransitionNotifier,
} from '../src/generation/index.js'

// ============================================================
// Fake pool estadoful — simula geracoes_projeto/projeto_chats
// com as guards reais de claim (status/worker_id).
// ============================================================

interface GeracaoRow {
  id: number
  projeto_id: number
  status: string
  briefing: string | null
  feedback: string | null
  worker_id: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  session_key: string | null
  modelo: string | null
  tasks: string | null
  erro: string | null
}

interface FakeDb {
  pool: Pool
  geracoes: GeracaoRow[]
  chats: Array<{ projeto_id: number; role: string; texto: string }>
  queries: Array<{ sql: string; params: unknown[] }>
}

function createFakeDb(geracoes: Array<Partial<GeracaoRow> & { id: number }>): FakeDb {
  const db: FakeDb = {
    pool: null as unknown as Pool,
    geracoes: geracoes.map(g => ({
      projeto_id: 13, status: 'pending', briefing: null, feedback: null,
      worker_id: null, claimed_at: null, lease_expires_at: null,
      session_key: null, modelo: null, tasks: null, erro: null, ...g,
    })),
    chats: [],
    queries: [],
  }
  const find = (id: number) => db.geracoes.find(row => row.id === Number(id))
  const header = (affectedRows: number): [ResultSetHeader, unknown[]] =>
    [{ affectedRows, insertId: 0 } as ResultSetHeader, []]
  const rows = (values: unknown[]): [unknown[], unknown[]] => [values, []]

  const query = async (sql: unknown, params?: unknown[]) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    const p = params ?? []
    db.queries.push({ sql: normalized, params: p })

    // Claim: SELECT do candidato pending
    if (normalized.startsWith('SELECT id FROM geracoes_projeto')) {
      return rows(db.geracoes
        .filter(row => row.status === 'pending' && (row.lease_expires_at == null || row.lease_expires_at < '2026-11-01 12:00:00'))
        .map(row => ({ id: row.id })))
    }
    // Claim: UPDATE condicional (guard status='pending')
    if (normalized.startsWith('UPDATE geracoes_projeto SET status = \'running\'')) {
      const [workerId, , id] = p as [string, number, number]
      const row = find(id)
      if (!row || row.status !== 'pending') return header(0)
      row.status = 'running'
      row.worker_id = workerId
      row.claimed_at = '2026-11-01 12:00:00'
      row.lease_expires_at = '2026-11-01 12:15:00'
      return header(1)
    }
    // Contexto (join geracao + projeto + agente + motor config)
    if (normalized.startsWith('SELECT g.id, g.projeto_id')) {
      const row = find(p[0] as number)
      if (!row) return rows([])
      return rows([{
        id: row.id, projeto_id: row.projeto_id, status: row.status, briefing: row.briefing,
        feedback: row.feedback, worker_id: row.worker_id,
        nome: 'Gestão de Tarefas Global', slug: 'gestao-tarefas', descricao: 'Sistema de gestão de tarefas com áreas e colaboradores.',
        agente_id: 'agente-gestao-tarefas', repo_path: null,
      }])
    }
    if (normalized.startsWith('SELECT role, texto FROM projeto_chats')) {
      return rows(db.chats.filter(chat => chat.projeto_id === Number(p[0])).map(chat => ({ role: chat.role, texto: chat.texto })))
    }
    if (normalized.startsWith('INSERT INTO projeto_chats')) {
      // SQL: VALUES (?, 'analyst', ?, NOW()) — role é literal; params = [projeto_id, texto].
      db.chats.push({ projeto_id: Number(p[0]), role: 'analyst', texto: String(p[1]) })
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET session_key')) {
      const [sessionKey, modelo, id, workerId] = p as [string, string, number, string]
      const row = find(id)
      if (!row || row.status !== 'running' || row.worker_id !== workerId) return header(0)
      row.session_key = sessionKey
      row.modelo = modelo
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET tasks')) {
      const [tasks, id, workerId] = p as [string, number, string]
      const row = find(id)
      if (!row || row.status !== 'running' || row.worker_id !== workerId) return header(0)
      row.tasks = tasks
      row.status = 'awaiting_approval'
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET status = \'awaiting_clarification\'')) {
      const [id, workerId] = p as [number, string]
      const row = find(id)
      if (!row || row.status !== 'running' || row.worker_id !== workerId) return header(0)
      row.status = 'awaiting_clarification'
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET status = \'failed\'')) {
      const [erro, id, workerId] = p as [string, number, string]
      const row = find(id)
      if (!row || row.status !== 'running' || row.worker_id !== workerId) return header(0)
      row.status = 'failed'
      row.erro = erro
      row.lease_expires_at = null
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET status = \'pending\'')) {
      const [id, workerId] = p as [number, string]
      const row = find(id)
      if (!row || row.status !== 'running' || row.worker_id !== workerId) return header(0)
      row.status = 'pending'
      row.worker_id = null
      row.claimed_at = null
      row.lease_expires_at = null
      return header(1)
    }
    if (normalized.startsWith('UPDATE geracoes_projeto SET lease_expires_at')) {
      const [, id, workerId] = p as [number, number, string]
      const row = find(id)
      return row && row.status === 'running' && row.worker_id === workerId ? header(1) : header(0)
    }
    throw new Error(`FakeDb: SQL não mapeado: ${normalized.slice(0, 120)}`)
  }
  db.pool = { query } as unknown as Pool
  return db
}

// ============================================================
// Fake console
// ============================================================

class FakeConsole implements AnalystConsole {
  createdSessions: Array<{ key: string; agentId: string; model?: string }> = []
  sentMessages: string[] = []
  constructor(
    private readonly responses: Array<string | { failed: string }>,
    private readonly failModels: Record<string, string> = {},
  ) {}
  async createSession(input: { key: string; agentId: string; model?: string; metadata: Record<string, unknown> }): Promise<AnalystSession> {
    if (input.model && this.failModels[input.model]) throw new Error(this.failModels[input.model])
    this.createdSessions.push({ key: input.key, agentId: input.agentId, model: input.model })
    return { sessionId: `sid-${input.model}`, sessionKey: input.key, agentId: input.agentId }
  }
  async sendMessage(input: { session: AnalystSession; message: string }): Promise<void> {
    this.sentMessages.push(input.message)
  }
  async getSessionStatus(): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }> {
    const response = this.responses.shift()
    if (response === undefined) return { isComplete: false }
    if (typeof response === 'string') return { isComplete: true, lastResponse: response }
    return { isComplete: false, isFailed: true, error: response.failed }
  }
}

const PLANO_VALIDO = JSON.stringify({
  kind: 'plano',
  classificacaoSistema: 'misto',
  requerAgenteDedicado: true,
  requisitos: [
    { id: 'REQ-F-001', texto: 'Cadastro de colaboradores com CPF.', origem: 'Seção 3', classificacao: 'crud' },
    { id: 'REQ-F-002', texto: 'Visão agrupada por área.', origem: 'Seção 4', classificacao: 'custom' },
  ],
  especificacaoCrud: { entidades: [{ nome: 'colaborador', campos: ['nome', 'cpf'], mascarasValidacoes: ['cpf'], menu: 'Cadastros' }], observacoes: 'Auth única da plataforma.' },
  tarefas: [
    { seq: 1, titulo: 'Modelo de dados e tenancy', objetivo: 'Definir entidades.', escopo: 'Schema e config.', aceite: ['Migration aplicada'], requisitos: ['REQ-F-001'], executor: 'biblioteca-global', depende_de: [], auto_start: false, risco: 'medio' },
    { seq: 2, titulo: 'Visão agrupada', objetivo: 'Tela custom.', escopo: 'Front.', aceite: ['Tela renderiza'], requisitos: ['REQ-F-002'], executor: 'agente-projeto', depende_de: [1], auto_start: false, risco: 'alto' },
  ],
  matrizCobertura: [
    { req: 'REQ-F-001', cobertoPor: 'crud:colaborador', justificativa: 'CRUD nativo.' },
    { req: 'REQ-F-002', cobertoPor: 'tarefa:2', justificativa: 'Tela custom.' },
  ],
  lacunas: [],
  lacunasBiblioteca: [{ funcionalidade: 'Visão agrupada por área', req: 'REQ-F-002', contexto: 'CRUD genérico não agrupa.' }],
  riscos: ['Especificação de integrações incompleta.'],
  foraDeFase: [],
})

const PERGUNTAS_VALIDAS = JSON.stringify({
  kind: 'perguntas',
  resumo: 'Entendi um sistema de tarefas por área.',
  perguntas: ['Há papéis de líder de área?', 'A visibilidade é por organização?'],
})

function promptResolverSpy() {
  const inputs: GenerationPromptInput[] = []
  return {
    inputs,
    resolve: async (input: GenerationPromptInput) => {
      inputs.push(input)
      return { text: `PROMPT-GERACAO:${input.nome}`, contractText: 'CONTRATO-§5' }
    },
  }
}

function createWorker(db: FakeDb, console_: FakeConsole, overrides: Record<string, unknown> = {}, workerId = 'w-test') {
  const resolver = promptResolverSpy()
  const worker = new ProjectGenerationWorker(db.pool, console_, {
    workerId,
    pollIntervalMs: 60_000,
    leaseTtlMs: 900_000,
    sessionPollIntervalMs: 1,
    sleep: async () => {},
    promptResolver: resolver,
    modelChainResolver: async () => ['openai/gpt-5.6-sol'],
    catalogoLoader: async () => '# Catálogo v1',
    docsLoader: async () => 'Sem documentação.',
    ...overrides,
  })
  return { worker, resolver }
}

// ============================================================
// Testes
// ============================================================

describe('ProjectGenerationWorker — claim e lease', () => {
  it('claima geracao pending com claim atômico + lease e chamadas concorrentes não duplicam o processamento', async () => {
    const db = createFakeDb([{ id: 7 }])
    const consoleA = new FakeConsole([PLANO_VALIDO])
    const consoleB = new FakeConsole([PLANO_VALIDO])
    const workerA = createWorker(db, consoleA, {}, 'w-a').worker
    const workerB = createWorker(db, consoleB, {}, 'w-b').worker

    await Promise.all([workerA.tick(), workerB.tick()])

    // Apenas um worker venceu o claim (UPDATE condicional: affectedRows=0 perde).
    expect(consoleA.createdSessions.length + consoleB.createdSessions.length).toBe(1)
    const geracao = db.geracoes[0]
    expect(geracao.status).toBe('awaiting_approval')
    expect(['w-a', 'w-b']).toContain(geracao.worker_id)
    const claim = db.queries.find(q => q.sql.startsWith('UPDATE geracoes_projeto SET status = \'running\''))!
    expect(claim.sql).toContain('worker_id = ?')
    expect(claim.sql).toContain('claimed_at = NOW()')
    expect(claim.sql).toContain('lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)')
    expect(claim.sql).toContain('WHERE id = ? AND status = \'pending\' AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))')
  })

  it('não claima geracao que não seja pending', async () => {
    const db = createFakeDb([{ id: 8, status: 'awaiting_approval' }])
    const console_ = new FakeConsole([])
    const { worker } = createWorker(db, console_)

    await worker.tick()

    expect(console_.createdSessions).toHaveLength(0)
    expect(db.geracoes[0].status).toBe('awaiting_approval')
  })
})

describe('ProjectGenerationWorker — contrato §5', () => {
  it('kind=plano → plano JSON gravado em geracoes_projeto.tasks + status=awaiting_approval + sessão/modelo registrados', async () => {
    const db = createFakeDb([{ id: 10 }])
    const console_ = new FakeConsole([PLANO_VALIDO])
    const { worker } = createWorker(db, console_)

    await worker.tick()

    const geracao = db.geracoes[0]
    expect(geracao.status).toBe('awaiting_approval')
    expect(geracao.session_key).toBe('geracao-10-openai/gpt-5.6-sol')
    expect(geracao.modelo).toBe('openai/gpt-5.6-sol')
    const plano = JSON.parse(String(geracao.tasks))
    expect(plano.kind).toBe('plano')
    expect(plano.requisitos.map((r: { id: string }) => r.id)).toEqual(['REQ-F-001', 'REQ-F-002'])
    expect(plano.especificacaoCrud.entidades[0].nome).toBe('colaborador')
    expect(plano.tarefas).toHaveLength(2)
    expect(plano.tarefas[1].executor).toBe('agente-projeto')
    expect(plano.matrizCobertura).toHaveLength(2)
    expect(plano.lacunasBiblioteca[0].funcionalidade).toBe('Visão agrupada por área')
    // Sessão do analista disparada com o agente do projeto.
    expect(console_.createdSessions[0].agentId).toBe('agente-gestao-tarefas')
  })

  it('kind=perguntas → mensagem role=analyst no chat do projeto + status=awaiting_clarification', async () => {
    const db = createFakeDb([{ id: 11 }])
    const console_ = new FakeConsole([PERGUNTAS_VALIDAS])
    const { worker } = createWorker(db, console_)

    await worker.tick()

    expect(db.geracoes[0].status).toBe('awaiting_clarification')
    expect(db.geracoes[0].tasks).toBeNull()
    const mensagens = db.chats.filter(chat => chat.projeto_id === 13)
    expect(mensagens).toHaveLength(1)
    expect(mensagens[0].role).toBe('analyst')
    expect(mensagens[0].texto).toContain('Entendimento atual: Entendi um sistema de tarefas por área.')
    expect(mensagens[0].texto).toContain('1) Há papéis de líder de área?')
    expect(mensagens[0].texto).toContain('2) A visibilidade é por organização?')
    expect(mensagens[0].texto).toContain('Responda neste chat para continuar')
  })

  it('reprocessamento inclui histórico do chat e feedback (rodada revise) no prompt', async () => {
    const db = createFakeDb([{ id: 12, feedback: 'Divida a tarefa 2 em front e backend.' }])
    db.chats.push(
      { projeto_id: 13, role: 'analyst', texto: '1) Há papéis de líder?' },
      { projeto_id: 13, role: 'user', texto: '1: Sim, líder de área.' },
    )
    const console_ = new FakeConsole([PLANO_VALIDO])
    const { worker, resolver } = createWorker(db, console_)

    await worker.tick()

    const input = resolver.inputs[0]
    expect(input.nome).toBe('Gestão de Tarefas Global')
    expect(input.slug).toBe('gestao-tarefas')
    expect(input.especificacao).toContain('Sistema de gestão de tarefas')
    expect(input.catalogoCrud).toBe('# Catálogo v1')
    expect(input.chat).toContain('[analyst] 1) Há papéis de líder?')
    expect(input.chat).toContain('[user] 1: Sim, líder de área.')
    expect(input.feedback).toBe('Divida a tarefa 2 em front e backend.')
  })

  it('resposta inválida → correção na mesma sessão; esgotada → failed com erro, SEM bloqueio de tarefa', async () => {
    const db = createFakeDb([{ id: 13 }])
    const console_ = new FakeConsole(['desculpe, não entendi', 'continuando sem JSON'])
    const { worker } = createWorker(db, console_)

    await worker.tick()

    const geracao = db.geracoes[0]
    expect(geracao.status).toBe('failed')
    expect(geracao.erro).toMatch(/^contract_violation:/)
    // Retentativa limitada: prompt original + 1 correção na mesma sessão.
    expect(console_.sentMessages).toHaveLength(2)
    expect(console_.sentMessages[1]).toContain('violou o contrato de saída')
    expect(console_.createdSessions).toHaveLength(1)
    // Taxonomia: nunca fabrica bloqueio (docs/TAXONOMIA-ERROS-MOTOR.md).
    expect(db.queries.some(q => /INSERT INTO bloqueios/i.test(q.sql))).toBe(false)
  })

  it('plano que viola regra cruzada (requerAgenteDedicado=false com executor agente-projeto) → failed', async () => {
    const planoInvalido = JSON.stringify({
      ...JSON.parse(PLANO_VALIDO),
      requerAgenteDedicado: false,
    })
    const db = createFakeDb([{ id: 14 }])
    const console_ = new FakeConsole([planoInvalido, planoInvalido])
    const { worker } = createWorker(db, console_)

    await worker.tick()

    expect(db.geracoes[0].status).toBe('failed')
    expect(db.geracoes[0].erro).toContain('requerAgenteDedicado=false')
  })
})

describe('ProjectGenerationWorker — modelos e erros', () => {
  it('indisponibilidade de modelo escala na cadeia (default pago, sem modelo local)', async () => {
    const db = createFakeDb([{ id: 20 }])
    const console_ = new FakeConsole([PLANO_VALIDO], { 'openai/gpt-5.6-sol': 'Console HTTP 429: Too Many Requests' })
    const { worker } = createWorker(db, console_, {
      modelChainResolver: async () => ['openai/gpt-5.6-sol', 'alibaba/qwen3.8-max'],
    })

    await worker.tick()

    expect(console_.createdSessions).toHaveLength(1)
    expect(console_.createdSessions[0].model).toBe('alibaba/qwen3.8-max')
    expect(db.geracoes[0].status).toBe('awaiting_approval')
    expect(db.geracoes[0].modelo).toBe('alibaba/qwen3.8-max')
  })

  it('cadeia esgotada por indisponibilidade → failed com model_unavailable_exhausted, sem bloqueio', async () => {
    const db = createFakeDb([{ id: 21 }])
    const console_ = new FakeConsole([], {
      'm1': 'Console HTTP 401: missing-provider-auth',
      'm2': 'no API key found for provider',
    })
    const { worker } = createWorker(db, console_, { modelChainResolver: async () => ['m1', 'm2'] })

    await worker.tick()

    expect(db.geracoes[0].status).toBe('failed')
    expect(db.geracoes[0].erro).toMatch(/^model_unavailable_exhausted:/)
    expect(db.queries.some(q => /INSERT INTO bloqueios/i.test(q.sql))).toBe(false)
  })

  it('erro infra transitório (banco/Console fora) libera o claim de volta para pending — retry sem consumir a geração', async () => {
    const db = createFakeDb([{ id: 22 }])
    const console_ = new FakeConsole([])
    console_.createSession = async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:18789') as Error & { code: string }
      error.code = 'ECONNREFUSED'
      throw error
    }
    const { worker } = createWorker(db, console_)

    await worker.tick()

    const geracao = db.geracoes[0]
    expect(geracao.status).toBe('pending')
    expect(geracao.worker_id).toBeNull()
    expect(geracao.lease_expires_at).toBeNull()
    expect(geracao.erro).toBeNull()
  })

  it('resolveGenerationModelChain: config explícita filtra modelo local; sem config usa cadeia global; fallback default é pago', async () => {
    const withConfig = {
      query: async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('motor_configuracoes')) return [[{ valor: 'ollama/qwen3:8b,openai/gpt-5.6-sol' }], []]
        return [[], []]
      },
    } as unknown as Pool
    expect(await resolveGenerationModelChain(withConfig)).toEqual(['openai/gpt-5.6-sol'])

    const withGlobal = {
      query: async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('motor_configuracoes')) return [[], []]
        if (text.includes('global_model_selection')) return [[{ model: 'deepseek/deepseek-v4-flash' }, { model: 'ollama/llama3.3:70b' }], []]
        return [[], []]
      },
    } as unknown as Pool
    expect(await resolveGenerationModelChain(withGlobal)).toEqual(['deepseek/deepseek-v4-flash'])

    const empty = { query: async () => [[], []] } as unknown as Pool
    const fallback = await resolveGenerationModelChain(empty)
    expect(fallback).toEqual([...DEFAULT_GENERATION_MODEL_CHAIN])
    // Regra §1.6: planejamento nunca vai para modelo local.
    expect(fallback.some(isLocalModel)).toBe(false)

    const allLocal = {
      query: async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('motor_configuracoes')) return [[{ valor: 'ollama/qwen3:8b' }], []]
        return [[], []]
      },
    } as unknown as Pool
    expect((await resolveGenerationModelChain(allLocal)).some(isLocalModel)).toBe(false)
  })
})

describe('ManagedGenerationPromptResolver', () => {
  it('renderiza os marcadores do template ativo e injeta o contrato de saída', async () => {
    const pool = {
      query: async () => [[{
        texto: 'Projeto **NOME** (**SLUG**). Spec: **ESPECIFICACAO** Desc: **DESCRICAO** Cat: **CATALOGO_CRUD** Docs: **DOCS** Chat: **CHAT** FB: **FEEDBACK** **CONTRATOSAIDA**',
        instrucoes: 'Responda com JSON único (plano|perguntas).',
      }], []],
    } as unknown as Pool

    const resolved = await new ManagedGenerationPromptResolver(pool).resolve({
      nome: 'Gestão', slug: 'gestao', especificacao: 'SPEC', descricao: 'DESC',
      catalogoCrud: 'CATALOGO', docs: 'DOCS', chat: 'CHAT', feedback: 'FB',
    })

    expect(resolved.text).toContain('Projeto Gestão (gestao)')
    expect(resolved.text).toContain('Spec: SPEC Desc: DESC Cat: CATALOGO Docs: DOCS Chat: CHAT FB: FB')
    expect(resolved.text).toContain('Responda com JSON único (plano|perguntas).')
    expect(resolved.text).not.toContain('**CONTRATOSAIDA**')
    expect(resolved.contractText).toBe('Responda com JSON único (plano|perguntas).')
  })

  it('sem prompt ativo → prompt_configuration_missing (falha de configuração, não bloqueio)', async () => {
    const pool = { query: async () => [[], []] } as unknown as Pool
    await expect(new ManagedGenerationPromptResolver(pool).resolve({
      nome: '', slug: '', especificacao: '', descricao: '', catalogoCrud: '', docs: '', chat: '', feedback: '',
    })).rejects.toThrow(/prompt_configuration_missing: prompt ativo não encontrado: geracao\.plano_macro_projeto/)
  })
})

// ============================================================
// Notificação Telegram das transições (F2, task-p2-1057 subtarefa 2)
// ============================================================

function fakeNotifier(overrides: Partial<Record<keyof GenerationTransitionNotifier, () => Promise<void>>> = {}) {
  const calls: { kind: 'clarification' | 'approval'; input: unknown }[] = []
  const notifier: GenerationTransitionNotifier = {
    notifyAwaitingClarification: overrides.notifyAwaitingClarification
      ?? (async (input) => { calls.push({ kind: 'clarification', input }) }),
    notifyAwaitingApproval: overrides.notifyAwaitingApproval
      ?? (async (input) => { calls.push({ kind: 'approval', input }) }),
  }
  return { notifier, calls }
}

describe('ProjectGenerationWorker — notificação Telegram das transições', () => {
  it('kind=perguntas + transição vencedora → notifyAwaitingClarification com projeto, resumo e nº de perguntas', async () => {
    const db = createFakeDb([{ id: 30 }])
    const console_ = new FakeConsole([PERGUNTAS_VALIDAS])
    const { notifier, calls } = fakeNotifier()
    const { worker } = createWorker(db, console_, { notifier })

    await worker.tick()

    expect(db.geracoes[0].status).toBe('awaiting_clarification')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.kind).toBe('clarification')
    expect(calls[0]!.input).toEqual({
      nome: 'Gestão de Tarefas Global',
      slug: 'gestao-tarefas',
      resumo: 'Entendi um sistema de tarefas por área.',
      perguntas: 2,
    })
  })

  it('kind=plano + transição vencedora → notifyAwaitingApproval com nº de tarefas/requisitos', async () => {
    const db = createFakeDb([{ id: 31 }])
    const console_ = new FakeConsole([PLANO_VALIDO])
    const { notifier, calls } = fakeNotifier()
    const { worker } = createWorker(db, console_, { notifier })

    await worker.tick()

    expect(db.geracoes[0].status).toBe('awaiting_approval')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.kind).toBe('approval')
    expect(calls[0]!.input).toEqual({
      nome: 'Gestão de Tarefas Global',
      slug: 'gestao-tarefas',
      tarefas: 2,
      requisitos: 2,
    })
  })

  it('notifier que lança → transição de status persiste (best-effort, sem failed/release)', async () => {
    const db = createFakeDb([{ id: 32 }])
    const console_ = new FakeConsole([PLANO_VALIDO])
    const { notifier } = fakeNotifier({
      notifyAwaitingApproval: async () => { throw new Error('telegram fora do ar') },
    })
    const { worker } = createWorker(db, console_, { notifier })

    await worker.tick()

    const geracao = db.geracoes[0]
    expect(geracao.status).toBe('awaiting_approval')
    expect(geracao.erro).toBeNull()
    expect(geracao.tasks).not.toBeNull()
  })

  it('geração failed → nenhuma notificação de transição (só awaiting_* disparam)', async () => {
    const db = createFakeDb([{ id: 33 }])
    const console_ = new FakeConsole(['resposta sem JSON', 'outra resposta sem JSON'])
    const { notifier, calls } = fakeNotifier()
    const { worker } = createWorker(db, console_, { notifier })

    await worker.tick()

    expect(db.geracoes[0].status).toBe('failed')
    expect(calls).toHaveLength(0)
  })
})
