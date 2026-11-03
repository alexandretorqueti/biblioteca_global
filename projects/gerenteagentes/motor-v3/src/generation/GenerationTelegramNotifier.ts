/**
 * GenerationTelegramNotifier — notificação Telegram das transições da
 * Geração Macro (F2, docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §2 fluxo de
 * aprovação; task-p2-1057 subtarefa 2).
 *
 * Padrão mínimo já consolidado pelo `TelegramDlqAlertSender`
 * (queue/DlqReconciler.ts): fetch direto para
 * https://api.telegram.org/bot<token>/sendMessage, sem dependência nova.
 *
 * Credenciais (já presentes no env da API — nenhuma alteração de
 * infraestrutura/compose):
 * - `TELEGRAM_BOT_TOKEN` (reuso do token dos alertas DLQ);
 * - chat de destino: `TELEGRAM_GERACAO_CHAT_ID` com fallback para
 *   `TELEGRAM_DLQ_CHAT_ID`.
 * Sem token ou sem chat id → no-op com log explícito único (console.warn).
 *
 * REGRA: o disparo é sempre best-effort — falha de rede/Telegram NUNCA pode
 * falhar ou reverter a transição de status da geração (catch + console.warn).
 * Os métodos públicos nunca lançam.
 */

export interface GenerationClarificationNotice {
  /** Nome do projeto captado. */
  nome: string
  /** Slug do projeto captado. */
  slug: string
  /** Entendimento atual do analista (forma "perguntas" do contrato §5). */
  resumo?: string | null
  /** Quantidade de perguntas registradas no chat de clarificação. */
  perguntas: number
}

export interface GenerationApprovalNotice {
  nome: string
  slug: string
  /** Quantidade de tarefas do plano macro. */
  tarefas: number
  /** Quantidade de requisitos REQ-* do plano macro. */
  requisitos: number
}

/** Porta de notificação das transições (facilita testes/mocks nos consumidores). */
export interface GenerationTransitionNotifier {
  notifyAwaitingClarification(input: GenerationClarificationNotice): Promise<void>
  notifyAwaitingApproval(input: GenerationApprovalNotice): Promise<void>
}

/** Mensagem da transição para `awaiting_clarification`. */
export function buildGenerationClarificationMessage(input: GenerationClarificationNotice): string {
  const linhas = [
    '🤔 Geração Macro — aguardando clarificação',
    `Projeto: ${input.nome} (${input.slug})`,
  ]
  const resumo = String(input.resumo ?? '').trim()
  if (resumo) linhas.push(`Entendimento atual: ${resumo}`)
  linhas.push(
    `${input.perguntas} pergunta(s) registradas no chat do projeto.`,
    'Responda no chat de clarificação (tela do projeto captado) para a geração continuar.',
  )
  return linhas.join('\n')
}

/** Mensagem da transição para `awaiting_approval`. */
export function buildGenerationApprovalMessage(input: GenerationApprovalNotice): string {
  return [
    '📋 Geração Macro — plano aguardando aprovação',
    `Projeto: ${input.nome} (${input.slug})`,
    `Plano: ${input.tarefas} tarefa(s), ${input.requisitos} requisito(s).`,
    'Aprove, edite, peça revisão ou rejeite no painel "Plano do projeto" (tela do projeto captado).',
  ].join('\n')
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export class GenerationTelegramNotifier implements GenerationTransitionNotifier {
  private readonly botToken: string | undefined
  private readonly chatId: string | undefined
  private readonly fetchImpl: typeof fetch
  private warnedMissingConfig = false

  constructor(
    botToken?: string,
    chatId?: string,
    fetchImpl?: typeof fetch,
  ) {
    this.botToken = nonEmpty(botToken) ?? nonEmpty(process.env.TELEGRAM_BOT_TOKEN)
    // Destino: TELEGRAM_GERACAO_CHAT_ID com fallback para TELEGRAM_DLQ_CHAT_ID.
    this.chatId =
      nonEmpty(chatId)
      ?? nonEmpty(process.env.TELEGRAM_GERACAO_CHAT_ID)
      ?? nonEmpty(process.env.TELEGRAM_DLQ_CHAT_ID)
    this.fetchImpl = fetchImpl ?? fetch
  }

  async notifyAwaitingClarification(input: GenerationClarificationNotice): Promise<void> {
    await this.send(buildGenerationClarificationMessage(input))
  }

  async notifyAwaitingApproval(input: GenerationApprovalNotice): Promise<void> {
    await this.send(buildGenerationApprovalMessage(input))
  }

  /** Best-effort: nunca lança; sem credencial → no-op com log único. */
  private async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true
        console.warn(
          '[GenerationTelegramNotifier] Telegram não configurado (TELEGRAM_BOT_TOKEN + TELEGRAM_GERACAO_CHAT_ID/TELEGRAM_DLQ_CHAT_ID); notificações da geração macro só em log.',
        )
      }
      console.warn(`[GenerationTelegramNotifier] notificação (log-only): ${text.replace(/\n/g, ' | ')}`)
      return
    }
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      })
      if (!response.ok) {
        console.warn(
          `[GenerationTelegramNotifier] Telegram respondeu ${response.status}; transição da geração não afetada (best-effort).`,
        )
      }
    } catch (error) {
      console.warn(
        `[GenerationTelegramNotifier] falha no envio: ${error instanceof Error ? error.message : String(error)}; transição da geração não afetada (best-effort).`,
      )
    }
  }
}
