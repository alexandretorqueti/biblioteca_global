/**
 * isa-chat.service.ts — Lógica de negócio do chat da Isa.
 *
 * Orquestra persistência (Drizzle/MySQL) e ponte (OpenClaw).
 * Não conhece HTTP nem BFF — recebe injeções.
 */
import { Injectable, Inject, Logger, BadRequestException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash } from "node:crypto"
import { eq, and, desc, isNull } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import * as nodemailer from "nodemailer"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../../../../apps/api/src/modules/crud/project-db.factory"
import {
  chats,
  chatMensagens,
  contatos,
  definicoes,
  visitasSite,
  emailVerifications,
  projetosCaptados,
} from "../../schema"
import { IsaChatBridgeService } from "./isa-chat.bridge"
import { extractTextFromFile } from "@biblioteca-global/file-extract"
import type {
  CreateSessionInput,
  SessionResult,
  SendMessageInput,
  SendMessageResult,
  ChatHistoryResult,
  OnboardingState,
  SiteVisitInput,
  DefinitionResult,
  ProjectNameResult,
  FinalizeResult,
} from "./isa-chat.types"

/** Saudação estática do primeiro acesso (agente não é chamado). */
export function getWelcomeMessage(agentId: string): string {
  if (agentId === "alpha") {
    return "Olá! 👋 Sou a Alpha, assistente virtual do Grupo Alphaville. Estou aqui para ajudar você a descobrir o empreendimento ideal para seu perfil, apresentar nossos projetos de alto padrão e tirar todas as suas dúvidas sobre segurança, lazer e qualidade de vida. Como posso ajudar você hoje?"
  }
  return "Olá! 👋 Sou a Isa, da Global Tecnologia. Envie sua mensagem para eu te ajudar a construir o sistema que você precisa."
}

function agentIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith("agent:")) return undefined
  return sessionKey.split(":")[1] || undefined
}

/** Lembrete de transparência (injetado no contexto da Isa). */
export const TRANSPARENCY_REMINDER =
  "Lembrete obrigatório de transparência: SEMPRE deixe claro para o cliente que (1) todas as conversas são gravadas (o histórico fica salvo e ele pode voltar depois) e (2) o sistema ainda está em modo DEMO (não é o produto final)."

/** Tempo de vida do código de verificação (10 min). */
export const CODE_TTL_MS = 10 * 60 * 1000

/** Máximo de tentativas por código. */
export const MAX_ATTEMPTS = 5

/** Regex de email válido. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Regex de telefone BR (10-11 dígitos com separadores). */
const BR_PHONE_RE = /^\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

export function isValidBrPhone(telefone: string): boolean {
  return BR_PHONE_RE.test(telefone.trim())
}

/** Gera código de 6 dígitos. */
function generateCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")
}

/** Hash HMAC-SHA256 do código + email. */
function hashCode(code: string, email: string, secret: string): string {
  return createHash("sha256")
    .update(`${code.trim()}::${email.trim().toLowerCase()}::${secret}`)
    .digest("hex")
}

/** Slug do nome do projeto (a-z0-9 e hífen, sem acentos — padrão legado). */
function slugDoNomeProjeto(value: string): string {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  const result = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)
  return result
}

/** Descrição fallback: definições numeradas (padrão do provisioner legado). */
function descricaoDasDefinicoes(defs: Array<{ texto: string }>): string {
  return defs.map((d, i) => `${i + 1}. ${d.texto}`).join("\n")
}

/** Monta o bloco de estado injetado no contexto da Isa a cada turno. */
export function describeOnboardingState(chat: {
  id: number
  status: string
  visitorName: string | null
  pendingEmail: string | null
  contatoNome?: string | null
  contatoEmail?: string | null
  contatoTelefone?: string | null
}): string {
  const lines: string[] = ["[Estado do onboarding]", `chatId técnico (use nas ferramentas): ${chat.id}`]
  if (chat.contatoEmail) {
    lines.push(`Identidade verificada: ${chat.contatoNome ? `${chat.contatoNome} <${chat.contatoEmail}>` : chat.contatoEmail}. NÃO peça nome ou email novamente.`)
    if (chat.contatoTelefone) {
      lines.push(`Telefone registrado: ${chat.contatoTelefone}. NÃO peça o telefone novamente.`)
    } else {
      lines.push("Telefone: (não coletado). Quando for o momento natural da conversa, peça o telefone do cliente (com DDD) e registre com a ferramenta registrar_telefone.")
    }
  } else if (chat.status === "aguardando_codigo" && chat.pendingEmail) {
    lines.push(`Nome coletado: ${chat.visitorName || "(ainda não informado)"}.`)
    lines.push(`Email informado, aguardando o código de confirmação enviado para ${chat.pendingEmail}.`)
    lines.push("Quando o cliente disser o código, chame a ferramenta de verificação. Se disser que não recebeu, chame a ferramenta de reenvio. Nunca invente ou exiba o código.")
  } else {
    lines.push(`Visitante ainda não verificado. Nome: ${chat.visitorName || "(não coletado)"}. Email: ${chat.pendingEmail || "(não coletado)"}.`)
    lines.push("Objetivo: conduza a conversa naturalmente e, quando for o momento, colete nome e email usando as ferramentas de registro.")
  }
  lines.push(TRANSPARENCY_REMINDER)
  return lines.join("\n")
}

@Injectable()
export class IsaChatService {
  private readonly logger = new Logger(IsaChatService.name)
  private readonly projectId: number
  private readonly verificationSecret: string
  private readonly mailer: nodemailer.Transporter | null
  private readonly smtpFrom: string
  private readonly smtpDebugLog: boolean

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    private readonly bridge: IsaChatBridgeService,
    private readonly configService: ConfigService,
  ) {
    this.projectId = Number(this.configService.get<string>("ISA_PROJECT_ID")) || 640
    this.verificationSecret =
      this.configService.get<string>("ISA_VERIFICATION_SECRET") || "globalia-onboarding-dev-secret"

    // Configuração SMTP
    const smtpHost = this.configService.get<string>("SMTP_HOST")
    const smtpPort = Number(this.configService.get<string>("SMTP_PORT") ?? "587")
    const smtpUser = this.configService.get<string>("SMTP_USER")
    const smtpPassword = this.configService.get<string>("SMTP_PASSWORD")
    this.smtpFrom = this.configService.get<string>("SMTP_FROM") || "noreply@globaltecnologia.com.br"
    this.smtpDebugLog = this.configService.get<string>("AUTH_CODE_DEBUG_LOG") === "true"

    if (smtpHost) {
      this.mailer = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPassword } : undefined,
      })
      this.logger.log(`SMTP configurado: ${smtpHost}:${smtpPort}`)
    } else {
      this.mailer = null
      this.logger.warn("SMTP não configurado — códigos de verificação serão apenas logados")
    }
  }

  /** Obtém a conexão com o banco do projeto GerenteAgentes. */
  private async getDb(): Promise<MySql2Database> {
    return this.factory.obter({ id: this.projectId })
  }

  /** Verifica se a ponte está configurada. */
  isBridgeConfigured(): boolean {
    return this.bridge.isConfigured()
  }

  /** Envia email com código de verificação. */
  private async sendVerificationEmail(email: string, code: string): Promise<boolean> {
    if (!this.mailer) {
      // SMTP não configurado — apenas loga
      if (this.smtpDebugLog) {
        this.logger.log(`Código de verificação para ${email}: ${code} (modo dev, SMTP não configurado)`)
      }
      return false
    }

    try {
      const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1976d2;">Verificação de email — Isa / Global Tecnologia</h2>
          <p>Olá!</p>
          <p>Use este código para verificar seu email:</p>
          <div style="background: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0;">
            <h1 style="color: #1976d2; letter-spacing: 8px; margin: 0;">${code}</h1>
          </div>
          <p>Este código expira em 10 minutos.</p>
          <p style="color: #666; font-size: 12px; margin-top: 30px;">
            Se você não solicitou este código, pode ignorar este email.
          </p>
        </div>
      `

      const text = `Seu código de verificação: ${code}\n\nEste código expira em 10 minutos.`

      await this.mailer.sendMail({
        from: this.smtpFrom,
        to: email,
        subject: `Código de verificação: ${code}`,
        text,
        html,
      })

      this.logger.log(`Email de verificação enviado para ${email}`)
      return true
    } catch (error) {
      this.logger.error(`Falha ao enviar email para ${email}: ${error}`)
      return false
    }
  }

  // ===========================================================================
  // SESSÃO
  // ===========================================================================

  /**
   * Cria ou recupera uma sessão de chat.
   * - Modo anônimo: { chatKey } — visitante novo, onboarding conduzido pela Isa
   * - Modo legado: { email, nome? } — resolve/cria pelo email
   */
  async createSession(input: CreateSessionInput): Promise<SessionResult> {
    const db = await this.getDb()
    const email = input.email?.trim().toLowerCase() || ""
    const chatKey = input.chatKey?.trim() || ""
    const nome = input.nome?.trim()

    // Modo anônimo (chatKey)
    if (!email && chatKey) {
      const existing = await db
        .select()
        .from(chats)
        .where(eq(chats.chatKey, chatKey))
        .limit(1)

      if (existing.length === 0) {
        // Criar o chat no banco (projeto_id null para chat anônimo)
        const [inserted] = await db
          .insert(chats)
          .values({
            chatKey,
            status: "aberto",
          })
          .$returningId()

        if (!inserted) {
          throw new Error("Falha ao criar chat")
        }

        // Gravar saudação estática (agente não é chamado)
        const agentId = input.agentId || this.configService.get<string>("ISA_AGENT_ID") || "isa"
        await db.insert(chatMensagens).values({
          chatId: inserted.id,
          role: "agent",
          texto: getWelcomeMessage(agentId),
        })

        return {
          ok: true,
          chatId: String(inserted.id),
          existing: false,
          onboarding: { state: "novo", verified: false },
        }
      }

      const chat = existing[0]!
      const onboarding = await this.buildOnboardingState(db, chat)

      return {
        ok: true,
        chatId: String(chat.id),
        existing: true,
        onboarding,
        ...(chat.contatoId ? { contactId: chat.contatoId } : {}),
      }
    }

    // Modo legado (email)
    if (!email) {
      throw new BadRequestException("chatKey ou email é obrigatório")
    }

    if (!this.bridge.isConfigured()) {
      throw new BadRequestException("Ponte OpenClaw não configurada")
    }

    // Busca ou cria contato
    const contatoResult = await db.select().from(contatos).where(eq(contatos.email, email)).limit(1)
    let contatoId: number

    if (contatoResult.length === 0) {
      const [inserted] = await db
        .insert(contatos)
        .values({ email, nome: nome || null })
        .$returningId()
      contatoId = inserted!.id
    } else {
      contatoId = contatoResult[0]!.id
    }

    // Busca ou cria chat
    const chatResult = await db
      .select()
      .from(chats)
      .where(eq(contatos.email, email))
      .innerJoin(contatos, eq(chats.contatoId, contatos.id))
      .limit(1)

    let chatId: number
    let chatSessionKey: string | null
    let chatState: string

    if (chatResult.length === 0) {
      const [inserted] = await db
        .insert(chats)
        .values({
          contatoId,
          status: "autenticado",
        })
        .$returningId()
      chatId = inserted!.id
      chatSessionKey = null
      chatState = "autenticado"

      // Grava saudação inicial
      await db.insert(chatMensagens).values({
        chatId,
        role: "agent",
        texto: `Olá${nome ? `, ${nome}` : ""}! Sou a Isa, da Global Tecnologia. Como posso ajudar a construir o sistema para você?`,
      })
    } else {
      chatId = chatResult[0]!.chats.id
      chatSessionKey = chatResult[0]!.chats.sessionKey
      chatState = chatResult[0]!.chats.status
    }

    // Resolve sessão no OpenClaw
    const resolved = await this.bridge.resolveSession({
      agentId: this.configService.get<string>("ISA_AGENT_ID") || "isa",
      chatKey: email,
    })

    if (chatSessionKey !== resolved.sessionKey) {
      await db.update(chats).set({ sessionKey: resolved.sessionKey }).where(eq(chats.id, chatId))
    }

    return {
      ok: true,
      chatId: String(chatId),
      existing: chatResult.length > 0,
      contactId: contatoId,
      onboarding: { state: chatState, verified: true, name: nome, email },
    }
  }

  // ===========================================================================
  // ENVIO DE MENSAGEM
  // ===========================================================================

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const db = await this.getDb()
    const chatId = input.chatId.trim()
    const agentId = input.agentId || this.configService.get<string>("ISA_AGENT_ID") || "isa"

    if (!chatId || (!input.text && (!input.attachments || input.attachments.length === 0))) {
      throw new BadRequestException("chatId e text/attachments são obrigatórios")
    }

    // Busca chat (por ID ou chatKey)
    let chat = await this.findChat(db, chatId)

    if (!chat) {
      // chatId pode ser o chatKey provisório — materializa agora
      if (chatId.length <= 255 && this.bridge.isConfigured()) {
        const [inserted] = await db
          .insert(chats)
          .values({ chatKey: chatId, status: "novo" })
          .$returningId()
        const newChatId = inserted!.id

        // Grava saudação
        await db.insert(chatMensagens).values({
          chatId: newChatId,
          role: "agent",
          texto: getWelcomeMessage(agentId),
        })

        chat = await db.select().from(chats).where(eq(chats.id, newChatId)).limit(1).then((r) => r[0] ?? null)
      }
    }

    if (!chat) {
      return { ok: false, reason: "chat_not_found", retryable: false }
    }

    // Processa anexos PRIMEIRO (antes de persistir)
    const attachmentRefs: Array<{ name: string; size?: string; kind: string; extracted: boolean }> = []
    let attachmentsBlock = ""

    for (const a of input.attachments ?? []) {
      const name = a.name || "anexo"
      let data: Uint8Array | null = null

      if (a.base64) {
        try {
          data = new Uint8Array(Buffer.from(a.base64, "base64"))
        } catch {
          data = null
        }
      }

      if (!data || data.length === 0) {
        attachmentRefs.push({ name, size: a.size, kind: "empty", extracted: false })
        attachmentsBlock += `\n[Arquivo anexado: ${name} — não foi possível ler (vazio ou inválido)]`
        continue
      }

      const extracted = await extractTextFromFile({ name, mime: a.mime, data })
      attachmentRefs.push({ name, size: a.size, kind: extracted.kind, extracted: extracted.ok })

      if (extracted.ok) {
        const maxLen = 8000
        const slice = extracted.text.length > maxLen ? `${extracted.text.slice(0, maxLen)}\n[... truncado ...]` : extracted.text
        attachmentsBlock += `\n\n--- Início do anexo: ${name} ---\n${slice}\n--- Fim do anexo: ${name} ---`
      } else {
        attachmentsBlock += `\n[Arquivo anexado: ${name} — ${extracted.message ?? "não foi possível extrair o texto"}]`
      }
    }

    // Monta texto final
    const finalText = attachmentsBlock ? `${input.text}${attachmentsBlock}`.trim() : input.text

    // Persiste mensagem do usuário (ANTES de tentar enviar para a ponte)
    await db.insert(chatMensagens).values({
      chatId: chat.id,
      role: "user",
      texto: finalText,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : null,
    })

    // Verifica se a ponte está configurada
    if (!this.bridge.isConfigured()) {
      return { ok: false, reason: "unavailable", retryable: true }
    }

    // Garante sessão no OpenClaw
    let sessionKey = chat.sessionKey
    // O chat público pode ter sido criado antes do agentId chegar ao endpoint.
    // Neste caso, recria a sessão no BFF para o agente solicitado, em vez de
    // reutilizar uma sessão legada da Isa para outro agente (por exemplo Alpha).
    if (!sessionKey || agentIdFromSessionKey(sessionKey) !== agentId) {
      const resolved = await this.bridge.resolveSession({
        agentId,
        chatKey: chat.chatKey ?? String(chat.id),
      })
      sessionKey = resolved.sessionKey
      await db.update(chats).set({ sessionKey }).where(eq(chats.id, chat.id))
    }

    // Injeta contexto de identidade + estado do onboarding no turno
    // (redesenho 2026-08-12): a Isa sempre sabe quem está falando e o
    // que já foi coletado — nunca pede nome/email de novo.
    let agentText = finalText
    try {
      if (chat.contatoId) {
        const contatoResult = await db.select().from(contatos).where(eq(contatos.id, chat.contatoId)).limit(1)
        if (contatoResult.length > 0) {
          const contato = contatoResult[0]!
          agentText = `${describeOnboardingState({
            id: chat.id,
            status: chat.status,
            visitorName: chat.visitorName,
            pendingEmail: chat.pendingEmail,
            contatoNome: contato.nome,
            contatoEmail: contato.email,
            contatoTelefone: contato.telefone,
          })}\n\n${agentText}`
        }
      } else {
        agentText = `${describeOnboardingState({
          id: chat.id,
          status: chat.status,
          visitorName: chat.visitorName,
          pendingEmail: chat.pendingEmail,
        })}\n\n${agentText}`
      }
    } catch {
      // Sem dados do contato → envia sem prefixo (best-effort).
    }

    // Envia para o agente
    const sendResult = await this.bridge.send({
      sessionKey,
      text: agentText,
      attachments: (input.attachments ?? []).map((a) => ({ name: a.name, size: a.size })),
    })

    if (!sendResult.ok) {
      return {
        ok: false,
        reason: sendResult.retryable ? "offline" : "http_error",
        retryable: sendResult.retryable,
      }
    }

    // Sincroniza respostas do agente (lazy sync)
    await this.syncAgentMessages(db, chat.id, sessionKey)

    return { ok: true, messageId: sendResult.messageId }
  }

  // ===========================================================================
  // HISTÓRICO
  // ===========================================================================

  async getHistory(chatId: string): Promise<ChatHistoryResult> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)

    if (!chat) {
      return {
        ok: false,
        chatId,
        messages: [],
        project: { name: null, definitions: [] },
        onboarding: { state: "novo", verified: false },
      }
    }

    // Garante session_key para chats que não têm (criados antes da ponte estar configurada)
    let sessionKey = chat.sessionKey
    if (!sessionKey && this.bridge.isConfigured() && chat.chatKey) {
      const resolved = await this.bridge.resolveSession({
        agentId: this.configService.get<string>("ISA_AGENT_ID") || "isa",
        chatKey: chat.chatKey,
      })
      sessionKey = resolved.sessionKey
      await db.update(chats).set({ sessionKey }).where(eq(chats.id, chat.id))
    }

    // Sync lazy das mensagens do agente
    if (sessionKey && this.bridge.isConfigured()) {
      await this.syncAgentMessages(db, chat.id, sessionKey)
    }

    // Busca mensagens
    const messages = await db
      .select()
      .from(chatMensagens)
      .where(eq(chatMensagens.chatId, chat.id))
      .orderBy(chatMensagens.createdAt)

    // Busca definições: do projeto vinculado OU do buffer do chat (pré-fechamento)
    let projectDefs: Array<{ id: string; definition: string; createdAt: string }> = []
    let projectName: string | null = null

    if (chat.projetoId) {
      const projeto = await db
        .select()
        .from(projetosCaptados)
        .where(eq(projetosCaptados.id, chat.projetoId))
        .limit(1)
      projectName = projeto[0]?.nome ?? null

      const defs = await db
        .select()
        .from(definicoes)
        .where(eq(definicoes.projetoId, chat.projetoId))
        .orderBy(definicoes.seq)

      projectDefs = defs.map((d) => ({
        id: String(d.id),
        definition: d.texto,
        createdAt: d.createdAt.toISOString(),
      }))
    } else {
      projectName = chat.nomeProjeto ?? null

      const buffered = await db
        .select()
        .from(definicoes)
        .where(and(eq(definicoes.chatId, chat.id), isNull(definicoes.projetoId)))
        .orderBy(definicoes.seq)
        .limit(10000)

      projectDefs = buffered.map((d) => ({
        id: String(d.id),
        definition: d.texto,
        createdAt: d.createdAt.toISOString(),
      }))
    }

    const onboarding = await this.buildOnboardingState(db, chat)

    return {
      ok: true,
      chatId: String(chat.id),
      messages: messages.map((m) => ({
        id: String(m.id),
        role: m.role === "assistant" ? "agent" : (m.role as "user" | "agent" | "system"),
        text: m.texto,
        createdAt: m.createdAt,
      })),
      project: { name: projectName, definitions: projectDefs },
      onboarding,
    }
  }

  // ===========================================================================
  // VISITA
  // ===========================================================================

  async recordVisit(input: SiteVisitInput): Promise<{ ok: boolean }> {
    const db = await this.getDb()
    const ipHash = input.remoteIp
      ? createHash("sha256").update(input.remoteIp).digest("hex")
      : null

    await db.insert(visitasSite).values({
      visitorKey: input.visitorKey?.slice(0, 255) ?? null,
      pageUrl: input.pageUrl?.slice(0, 4000) ?? null,
      referrer: input.referrer?.slice(0, 4000) ?? null,
      userAgent: input.userAgent?.slice(0, 2000) ?? null,
      ipHash,
    })

    return { ok: true }
  }

  // ===========================================================================
  // ONBOARDING
  // ===========================================================================

  async setVisitorName(chatId: string, nome: string): Promise<{ ok: boolean; chatId: string }> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) throw new BadRequestException("Chat não encontrado")

    await db.update(chats).set({ visitorName: nome.slice(0, 150) }).where(eq(chats.id, chat.id))
    return { ok: true, chatId: String(chat.id) }
  }

  async startEmailVerification(
    chatId: string,
    email: string,
  ): Promise<{ ok: boolean; expiresAt?: Date; reason?: string }> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) throw new BadRequestException("Chat não encontrado")

    if (!isValidEmail(email)) {
      return { ok: false, reason: "invalid_email" }
    }

    const code = generateCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    const codeHash = hashCode(code, email, this.verificationSecret)

    await db.insert(emailVerifications).values({
      chatId: chat.id,
      email: email.toLowerCase(),
      codeHash,
      expiresAt,
    })

    await db.update(chats).set({ pendingEmail: email.toLowerCase() }).where(eq(chats.id, chat.id))

    // Envia email com código de verificação
    const sent = await this.sendVerificationEmail(email.toLowerCase(), code)
    if (!sent && !this.mailer) {
      this.logger.warn(`Email não enviado para ${email} — SMTP não configurado. Código: ${code}`)
    }

    return { ok: true, expiresAt }
  }

  async verifyEmailCode(
    chatId: string,
    email: string,
    code: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) throw new BadRequestException("Chat não encontrado")

    const normalizedEmail = email.trim().toLowerCase()
    const expectedHash = hashCode(code, normalizedEmail, this.verificationSecret)

    const verification = await db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.chatId, chat.id),
          eq(emailVerifications.email, normalizedEmail),
          eq(emailVerifications.used, false),
        ),
      )
      .orderBy(desc(emailVerifications.createdAt))
      .limit(1)

    if (verification.length === 0) {
      return { ok: false, reason: "no_active_code" }
    }

    const v = verification[0]!

    if (v.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "expired" }
    }

    if (v.attempts >= MAX_ATTEMPTS) {
      return { ok: false, reason: "too_many_attempts" }
    }

    if (v.codeHash !== expectedHash) {
      await db
        .update(emailVerifications)
        .set({ attempts: v.attempts + 1 })
        .where(eq(emailVerifications.id, v.id))
      return { ok: false, reason: "wrong_code" }
    }

    // Código correto — marca como usado e cria/atualiza contato
    await db.update(emailVerifications).set({ used: true }).where(eq(emailVerifications.id, v.id))

    // Busca ou cria contato
    const contatoResult = await db.select().from(contatos).where(eq(contatos.email, normalizedEmail)).limit(1)
    let contatoId: number

    if (contatoResult.length === 0) {
      const [inserted] = await db
        .insert(contatos)
        .values({ email: normalizedEmail, nome: chat.visitorName })
        .$returningId()
      contatoId = inserted!.id
    } else {
      contatoId = contatoResult[0]!.id
      if (!contatoResult[0]!.nome && chat.visitorName) {
        await db.update(contatos).set({ nome: chat.visitorName }).where(eq(contatos.id, contatoId))
      }
    }

    // Vincula contato ao chat e atualiza estado
    await db
      .update(chats)
      .set({ contatoId, status: "verificado", pendingEmail: null })
      .where(eq(chats.id, chat.id))

    return { ok: true }
  }

  async resendVerificationCode(
    chatId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) throw new BadRequestException("Chat não encontrado")

    if (!chat.pendingEmail) {
      return { ok: false, reason: "no_pending_email" }
    }

    return this.startEmailVerification(chatId, chat.pendingEmail)
  }

  async setVisitorPhone(
    chatId: string,
    telefone: string,
  ): Promise<{ ok: boolean; chatId: string; reason?: string }> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) throw new BadRequestException("Chat não encontrado")

    if (!isValidBrPhone(telefone)) {
      return { ok: false, reason: "invalid_phone", chatId: String(chat.id) }
    }

    if (!chat.contatoId) {
      return { ok: false, reason: "contact_not_found", chatId: String(chat.id) }
    }

    await db.update(contatos).set({ telefone }).where(eq(contatos.id, chat.contatoId))
    return { ok: true, chatId: String(chat.id) }
  }

  async finalizeOnboarding(chatId: string, descricao?: string): Promise<FinalizeResult> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) return { ok: false, chatId, reason: "chat_not_found" }

    // Fechamento exige identidade verificada (contato criado).
    if (!chat.contatoId) {
      return { ok: false, chatId: String(chat.id), reason: "not_verified" }
    }

    // Idempotência: chat já fechado — apenas atualiza a descrição se vier.
    if (chat.projetoId) {
      if (descricao?.trim()) {
        await db
          .update(projetosCaptados)
          .set({ descricao: descricao.trim() })
          .where(eq(projetosCaptados.id, chat.projetoId))
      }
      await db.update(chats).set({ status: "finalizado" }).where(eq(chats.id, chat.id))
      return { ok: true, chatId: String(chat.id), projetoId: String(chat.projetoId) }
    }

    // Nome do projeto é obrigatório (aprovado pelo cliente, sugerido pela Isa).
    const nomeProjeto = chat.nomeProjeto?.trim()
    if (!nomeProjeto) {
      return { ok: false, chatId: String(chat.id), reason: "project_name_required" }
    }

    // Definições coletadas no chat.
    const buffered = await db
      .select()
      .from(definicoes)
      .where(and(eq(definicoes.chatId, chat.id), isNull(definicoes.projetoId)))
      .orderBy(definicoes.seq)
      .limit(10000)

    if (buffered.length === 0) {
      return { ok: false, chatId: String(chat.id), reason: "no_definitions" }
    }

    // Slug único derivado do nome (sufixo -2, -3... em colisão).
    const base = slugDoNomeProjeto(nomeProjeto)
    if (!base) {
      return { ok: false, chatId: String(chat.id), reason: "project_name_required" }
    }
    let slug = base
    for (let i = 2; ; i += 1) {
      const exists = await db
        .select({ id: projetosCaptados.id })
        .from(projetosCaptados)
        .where(eq(projetosCaptados.slug, slug))
        .limit(1)
      if (exists.length === 0) break
      slug = `${base}-${i}`
    }

    // Descrição: redigida pela Isa; fallback determinístico (definições numeradas).
    const descricaoFinal = descricao?.trim() || descricaoDasDefinicoes(buffered)

    const [projeto] = await db
      .insert(projetosCaptados)
      .values({
        nome: nomeProjeto,
        slug,
        descricao: descricaoFinal,
        contatoId: chat.contatoId,
        ativo: true,
      })
      .$returningId()

    if (!projeto) {
      throw new Error("Falha ao criar projeto captado")
    }

    // Vincula as definições do buffer ao projeto recém-criado.
    await db
      .update(definicoes)
      .set({ projetoId: projeto.id, chatId: null })
      .where(and(eq(definicoes.chatId, chat.id), isNull(definicoes.projetoId)))

    await db
      .update(chats)
      .set({ projetoId: projeto.id, status: "finalizado" })
      .where(eq(chats.id, chat.id))

    this.logger.log(
      `Captação finalizada: chat ${chat.id} → projeto "${nomeProjeto}" (id ${projeto.id}, slug ${slug}, ${buffered.length} definições)`,
    )

    return { ok: true, chatId: String(chat.id), projetoId: String(projeto.id), slug }
  }

  // ===========================================================================
  // DEFINIÇÕES E PROJETO (fase de levantamento)
  // ===========================================================================

  /** Registra uma definição confirmada (buffer do chat ou projeto já criado). */
  async addDefinition(chatId: string, texto: string): Promise<DefinitionResult> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) return { ok: false, reason: "chat_not_found" }

    // Só registra com identidade verificada (cadastro completo).
    if (!chat.contatoId) return { ok: false, reason: "not_verified" }

    const definition = texto.trim()
    if (!definition) return { ok: false, reason: "definition_not_found" }

    // Seq estável: próxima posição no buffer do chat ou no projeto.
    const rows = chat.projetoId
      ? await db
          .select({ seq: definicoes.seq })
          .from(definicoes)
          .where(eq(definicoes.projetoId, chat.projetoId))
          .limit(10000)
      : await db
          .select({ seq: definicoes.seq })
          .from(definicoes)
          .where(eq(definicoes.chatId, chat.id))
          .limit(10000)
    const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1

    const [inserted] = await db
      .insert(definicoes)
      .values({
        projetoId: chat.projetoId ?? null,
        chatId: chat.projetoId ? null : chat.id,
        texto: definition,
        seq,
      })
      .$returningId()

    if (!inserted) throw new Error("Falha ao inserir definição")
    this.logger.log(`Definição registrada no chat ${chat.id}: "${definition.slice(0, 80)}"`)
    return { ok: true, id: String(inserted.id) }
  }

  /** Corrige uma definição já registrada (cliente mudou algo definido). */
  async updateDefinition(chatId: string, id: string, texto: string): Promise<DefinitionResult> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) return { ok: false, reason: "chat_not_found" }
    if (!chat.contatoId) return { ok: false, reason: "not_verified" }

    const definition = texto.trim()
    if (!definition) return { ok: false, reason: "definition_not_found" }

    const defId = Number(id)
    if (!Number.isInteger(defId)) return { ok: false, reason: "definition_not_found" }

    // A definição precisa pertencer ao chat (buffer) ou ao projeto do chat.
    const [existing] = await db.select().from(definicoes).where(eq(definicoes.id, defId)).limit(1)
    const belongsToChat = existing?.chatId === chat.id
    const belongsToProject =
      chat.projetoId !== null && existing?.projetoId === chat.projetoId
    if (!existing || (!belongsToChat && !belongsToProject)) {
      return { ok: false, reason: "definition_not_found" }
    }

    await db.update(definicoes).set({ texto: definition }).where(eq(definicoes.id, defId))
    return { ok: true, id }
  }

  /** Define o nome do projeto (aprovado pelo cliente, sugerido pela Isa). */
  async setProjectName(chatId: string, nome: string): Promise<ProjectNameResult> {
    const db = await this.getDb()
    const chat = await this.findChat(db, chatId)
    if (!chat) return { ok: false, reason: "chat_not_found" }

    const nomeProjeto = nome.trim().slice(0, 200)
    await db.update(chats).set({ nomeProjeto }).where(eq(chats.id, chat.id))

    // Se o projeto já existe (cliente voltou), atualiza o nome também.
    if (chat.projetoId && nomeProjeto) {
      await db
        .update(projetosCaptados)
        .set({ nome: nomeProjeto })
        .where(eq(projetosCaptados.id, chat.projetoId))
    }

    return { ok: true, chatId: String(chat.id) }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private async findChat(
    db: MySql2Database,
    chatId: string,
  ): Promise<(typeof chats.$inferSelect) | null> {
    // Tenta por ID numérico
    const numericId = Number(chatId)
    if (!Number.isNaN(numericId) && Number.isInteger(numericId)) {
      const result = await db.select().from(chats).where(eq(chats.id, numericId)).limit(1)
      if (result.length > 0) return result[0]!
    }

    // Tenta por chatKey
    const result = await db.select().from(chats).where(eq(chats.chatKey, chatId)).limit(1)
    return result[0] ?? null
  }

  private async buildOnboardingState(
    db: MySql2Database,
    chat: typeof chats.$inferSelect,
  ): Promise<OnboardingState> {
    if (chat.contatoId) {
      const contato = await db.select().from(contatos).where(eq(contatos.id, chat.contatoId)).limit(1)
      if (contato.length > 0) {
        return {
          state: chat.status,
          verified: true,
          name: contato[0]!.nome,
          email: contato[0]!.email,
          ...(contato[0]!.telefone ? { phone: contato[0]!.telefone } : {}),
        }
      }
    }

    return {
      state: chat.status,
      verified: false,
      name: chat.visitorName,
      email: chat.pendingEmail,
    }
  }

  private async syncAgentMessages(
    db: MySql2Database,
    chatId: number,
    sessionKey: string,
  ): Promise<void> {
    try {
      const bffMsgs = await this.bridge.history({ sessionKey, limit: 500 })
      if (bffMsgs.length === 0) return

      const pgMsgs = await db
        .select()
        .from(chatMensagens)
        .where(eq(chatMensagens.chatId, chatId))

      const existingAgent = new Set(
        pgMsgs.filter((m) => m.role === "agent").map((m) => m.texto.trim()),
      )

      for (const m of bffMsgs) {
        if (m.role !== "agent") continue
        const text = (m.text ?? "").trim()
        if (!text || existingAgent.has(text)) continue

        await db.insert(chatMensagens).values({
          chatId,
          role: "agent",
          texto: m.text ?? "",
        })
        existingAgent.add(text)
      }
    } catch (err) {
      this.logger.warn(`syncAgentMessages failed: ${err}`)
    }
  }
}
