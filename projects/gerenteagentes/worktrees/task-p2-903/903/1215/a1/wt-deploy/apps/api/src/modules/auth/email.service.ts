/**
 * EmailService — envio SMTP do código de verificação (auth única, D4/D5).
 * Segue o padrão do GerenteAgentes (nodemailer + envs SMTP_*).
 *
 * Sem SMTP configurado (dev), retorna { ok: false, reason: "smtp_not_configured" }
 * sem lançar exceção — permite testar a API sem e-mail real (passo a passo, Etapa 3).
 *
 * Regra de segurança: NUNCA logar o código nem a senha do SMTP (D5/D8).
 */
import { Inject, Injectable, Logger } from "@nestjs/common"
import nodemailer from "nodemailer"
import { EnvService } from "../../config/env.service"

export type EnvioEmailResultado =
  | { ok: true }
  | { ok: false; reason: "smtp_not_configured" | "envio_falhou" }

export interface SendVerificationEmailInput {
  to: string
  code: string
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)

  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  async sendVerificationEmail(
    input: SendVerificationEmailInput,
  ): Promise<EnvioEmailResultado> {
    const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom } = this.env
    if (!smtpHost || !smtpUser) {
      // APENAS DEBUG (flag explícita, default off): sem SMTP, o código sai
      // no log para a validação manual (Etapa 11). Nunca em produção.
      if (this.env.authCodeDebugLog) {
        this.logger.warn(
          "[DEBUG] SMTP não configurado — código de verificação: " +
            input.code +
            " (remova AUTH_CODE_DEBUG_LOG em produção)",
        )
      }
      return { ok: false, reason: "smtp_not_configured" }
    }

    try {
      const transporte = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPassword },
      })
      await transporte.sendMail({
        from: smtpFrom,
        to: input.to,
        subject: "Seu código de acesso — Global Tecnologia",
        text:
          "Seu código de acesso é " +
          input.code +
          " — válido por 10 minutos. " +
          "Se você não pediu este código, ignore este e-mail.",
      })
      return { ok: true }
    } catch {
      // Sem detalhes do erro no log: pode conter a senha do SMTP.
      this.logger.error("Falha ao enviar e-mail de verificação (SMTP)")
      return { ok: false, reason: "envio_falhou" }
    }
  }
}
