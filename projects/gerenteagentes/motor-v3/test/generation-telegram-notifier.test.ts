// @vitest-environment node
/**
 * GenerationTelegramNotifier (F2, task-p2-1057 subtarefa 2) — notificação
 * Telegram das transições da Geração Macro:
 * - com credencial → payload correto do sendMessage (token/chat/texto);
 * - destino TELEGRAM_GERACAO_CHAT_ID com fallback TELEGRAM_DLQ_CHAT_ID;
 * - sem credencial → no-op com log explícito único (sem fetch, sem exceção);
 * - falha HTTP/rede → nunca propaga (best-effort).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GenerationTelegramNotifier,
  buildGenerationApprovalMessage,
  buildGenerationClarificationMessage,
} from '../src/generation/index.js'

type FetchCall = { url: string; init: RequestInit }

function fakeFetch(response: { ok: boolean; status?: number } = { ok: true }) {
  const calls: FetchCall[] = []
  const impl = async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return response as Response
  }
  return { calls, impl: impl as unknown as typeof fetch }
}

const CLARIFICACAO = { nome: 'Gestão de Tarefas Global', slug: 'gestao-tarefas', resumo: 'Entendi um sistema de tarefas.', perguntas: 2 }
const APROVACAO = { nome: 'Gestão de Tarefas Global', slug: 'gestao-tarefas', tarefas: 5, requisitos: 3 }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('GenerationTelegramNotifier — envio com credencial', () => {
  it('awaiting_clarification → sendMessage com token no URL, chat_id e texto com projeto/resumo/nº de perguntas', async () => {
    const { calls, impl } = fakeFetch()
    const notifier = new GenerationTelegramNotifier('TOKEN-123', 'chat-geracao', impl)

    await notifier.notifyAwaitingClarification(CLARIFICACAO)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTOKEN-123/sendMessage')
    expect(calls[0]!.init.method).toBe('POST')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.chat_id).toBe('chat-geracao')
    expect(body.text).toContain('Gestão de Tarefas Global (gestao-tarefas)')
    expect(body.text).toContain('Entendimento atual: Entendi um sistema de tarefas.')
    expect(body.text).toContain('2 pergunta(s)')
    expect(body.text).toContain('aguardando clarificação')
  })

  it('awaiting_approval → texto com nº de tarefas/requisitos e instrução de aprovação na tela', async () => {
    const { calls, impl } = fakeFetch()
    const notifier = new GenerationTelegramNotifier('TOKEN-123', 'chat-geracao', impl)

    await notifier.notifyAwaitingApproval(APROVACAO)

    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.text).toContain('5 tarefa(s), 3 requisito(s)')
    expect(body.text).toContain('Plano do projeto')
    expect(buildGenerationApprovalMessage(APROVACAO)).toContain('aguardando aprovação')
  })

  it('sem TELEGRAM_GERACAO_CHAT_ID → fallback para TELEGRAM_DLQ_CHAT_ID (env)', async () => {
    vi.stubEnv('TELEGRAM_GERACAO_CHAT_ID', '')
    vi.stubEnv('TELEGRAM_DLQ_CHAT_ID', 'chat-dlq')
    const { calls, impl } = fakeFetch()
    const notifier = new GenerationTelegramNotifier('TOKEN-123', undefined, impl)

    await notifier.notifyAwaitingApproval(APROVACAO)

    expect(JSON.parse(String(calls[0]!.init.body)).chat_id).toBe('chat-dlq')
  })
})

describe('GenerationTelegramNotifier — sem credencial (no-op com log)', () => {
  it('sem token nem chat → não chama fetch e loga console.warn uma única vez', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    vi.stubEnv('TELEGRAM_GERACAO_CHAT_ID', '')
    vi.stubEnv('TELEGRAM_DLQ_CHAT_ID', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls, impl } = fakeFetch()
    const notifier = new GenerationTelegramNotifier(undefined, undefined, impl)

    await notifier.notifyAwaitingClarification(CLARIFICACAO)
    await notifier.notifyAwaitingApproval(APROVACAO)

    expect(calls).toHaveLength(0)
    const missingConfigWarns = warn.mock.calls.filter(call => String(call[0]).includes('Telegram não configurado'))
    expect(missingConfigWarns).toHaveLength(1)
    // Log-only explícito das duas notificações (critério de aceite).
    expect(warn.mock.calls.filter(call => String(call[0]).includes('log-only'))).toHaveLength(2)
  })
})

describe('GenerationTelegramNotifier — best-effort (falha nunca propaga)', () => {
  it('HTTP !ok → não lança, apenas console.warn', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { impl } = fakeFetch({ ok: false, status: 429 })
    const notifier = new GenerationTelegramNotifier('TOKEN-123', 'chat-geracao', impl)

    await expect(notifier.notifyAwaitingApproval(APROVACAO)).resolves.toBeUndefined()
  })

  it('falha de rede (fetch rejeita) → não lança', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const impl = (async () => { throw new Error('connect ETIMEDOUT') }) as unknown as typeof fetch
    const notifier = new GenerationTelegramNotifier('TOKEN-123', 'chat-geracao', impl)

    await expect(notifier.notifyAwaitingClarification(CLARIFICACAO)).resolves.toBeUndefined()
  })
})

describe('builders de mensagem', () => {
  it('clarificação sem resumo → mensagem não inclui linha de entendimento', () => {
    const text = buildGenerationClarificationMessage({ ...CLARIFICACAO, resumo: null })
    expect(text).not.toContain('Entendimento atual')
    expect(text).toContain('2 pergunta(s)')
  })
})
