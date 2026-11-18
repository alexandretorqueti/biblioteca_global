import { Inject, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import nodemailer from "nodemailer"
import type { TransbordoDestinoTipo } from "@biblioteca-global/shared"

export interface TransbordoResumo {
  nome: string
  assunto: string
  coletado: string[]
  pendencia: string
  historicoUrl: string
  liberacaoUrl: string
}

export interface TransbordoNotificacaoInput {
  tipo: TransbordoDestinoTipo
  destino: string
  atendenteNome: string
  resumo: TransbordoResumo
}

export type TransbordoNotificacaoResultado =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "unsupported" | "send_failed"; detail?: string }

export interface TransbordoNotifierAdapter {
  readonly tipo: TransbordoDestinoTipo
  enviar(input: TransbordoNotificacaoInput): Promise<TransbordoNotificacaoResultado>
}

export function formatarResumoTransbordo(resumo: TransbordoResumo): string {
  return [
    "🔔 TRANSPORTE PARA ATENDIMENTO HUMANO",
    `Nome: ${resumo.nome}`,
    `Assunto: ${resumo.assunto}`,
    "Informações coletadas:",
    ...(resumo.coletado.length ? resumo.coletado.map((item) => `- ${item}`) : ["- Nenhuma informação adicional"]),
    `Pendência: ${resumo.pendencia}`,
    `Histórico: ${resumo.historicoUrl}`,
    `Liberação: ${resumo.liberacaoUrl}`,
  ].join("\n")
}

@Injectable()
export class SmtpTransbordoAdapter implements TransbordoNotifierAdapter {
  readonly tipo = "email" as const
  private readonly logger = new Logger(SmtpTransbordoAdapter.name)

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async enviar(input: TransbordoNotificacaoInput): Promise<TransbordoNotificacaoResultado> {
    const host = this.config.get<string>("SMTP_HOST")
    const user = this.config.get<string>("SMTP_USER")
    if (!host || !user) return { ok: false, reason: "not_configured" }
    try {
      const port = Number(this.config.get<string>("SMTP_PORT") ?? "587")
      const transport = nodemailer.createTransport({
        host, port, secure: port === 465,
        auth: { user, pass: this.config.get<string>("SMTP_PASSWORD") ?? "" },
      })
      await transport.sendMail({
        from: this.config.get<string>("SMTP_FROM") ?? user,
        to: input.destino,
        subject: `[${input.atendenteNome}] Novo transbordo HelpDesk`,
        text: formatarResumoTransbordo(input.resumo),
      })
      return { ok: true }
    } catch {
      this.logger.error("Falha ao enviar notificação de transbordo por SMTP")
      return { ok: false, reason: "send_failed" }
    }
  }
}

@Injectable()
export class TelegramTransbordoAdapter implements TransbordoNotifierAdapter {
  readonly tipo = "telegram" as const

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async enviar(input: TransbordoNotificacaoInput): Promise<TransbordoNotificacaoResultado> {
    const token = this.config.get<string>("TELEGRAM_BOT_TOKEN")
    if (!token) return { ok: false, reason: "not_configured" }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: input.destino, text: formatarResumoTransbordo(input.resumo) }),
      })
      return response.ok ? { ok: true } : { ok: false, reason: "send_failed", detail: `status=${response.status}` }
    } catch {
      return { ok: false, reason: "send_failed" }
    }
  }
}

@Injectable()
export class WhatsAppTransbordoAdapter implements TransbordoNotifierAdapter {
  readonly tipo = "whatsapp" as const
  async enviar(input: TransbordoNotificacaoInput): Promise<TransbordoNotificacaoResultado> {
    void input
    return { ok: false, reason: "unsupported", detail: "Adapter WhatsApp ainda não está disponível" }
  }
}

@Injectable()
export class TransbordoNotifier {
  private readonly adapters: ReadonlyMap<TransbordoDestinoTipo, TransbordoNotifierAdapter>

  constructor(
    smtp: SmtpTransbordoAdapter,
    telegram: TelegramTransbordoAdapter,
    whatsapp: WhatsAppTransbordoAdapter,
  ) {
    const adapters: Array<[TransbordoDestinoTipo, TransbordoNotifierAdapter]> = [[smtp.tipo, smtp], [telegram.tipo, telegram], [whatsapp.tipo, whatsapp]]
    this.adapters = new Map(adapters)
  }

  enviar(input: TransbordoNotificacaoInput): Promise<TransbordoNotificacaoResultado> {
    return this.adapters.get(input.tipo)?.enviar(input) ?? Promise.resolve({ ok: false, reason: "unsupported" })
  }
}
