/**
 * isa-chat.controller.ts — Rotas públicas do chat da Isa.
 *
 * Todas as rotas são @Public() (sem JWT) pois o chat é acessado por visitantes anônimos.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common"
import { Public } from "../../../../apps/api/src/common/decorators/public.decorator"
import { IsaChatService } from "./isa-chat.service"
import type { Request } from "express"

@Controller()
@Public()
export class IsaChatController {
  private readonly logger = new Logger(IsaChatController.name)

  constructor(private readonly service: IsaChatService) {}

  // ===========================================================================
  // SESSÃO
  // ===========================================================================

  @Post("session")
  @HttpCode(HttpStatus.OK)
  async createSession(
    @Body() body: { chatKey?: string; email?: string; nome?: string; agentId?: string },
  ) {
    const chatKey = typeof body.chatKey === "string" ? body.chatKey.trim().slice(0, 255) : undefined
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) : undefined
    const nome = typeof body.nome === "string" ? body.nome.trim().slice(0, 150) : undefined
    const agentId = typeof body.agentId === "string" ? body.agentId.trim().slice(0, 100) : undefined

    if (!chatKey && !email) {
      throw new BadRequestException("chatKey ou email é obrigatório")
    }

    return this.service.createSession({ chatKey, email, nome, agentId })
  }

  // ===========================================================================
  // ENVIO DE MENSAGEM
  // ===========================================================================

  @Post("chat/send")
  @HttpCode(HttpStatus.OK)
  async sendMessage(
    @Body()
    body: {
      chatId?: string
      text?: string
      agentId?: string
      attachments?: Array<{
        name: string
        size?: string
        mime?: string
        base64?: string
      }>
    },
  ) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const text = typeof body.text === "string" ? body.text.trim() : ""
    const agentId = typeof body.agentId === "string" ? body.agentId.trim().slice(0, 100) : undefined
    const attachments = Array.isArray(body.attachments) ? body.attachments : []

    if (!chatId || (!text && attachments.length === 0)) {
      throw new BadRequestException("chatId e text/attachments são obrigatórios")
    }

    return this.service.sendMessage({ chatId, text, agentId, attachments })
  }

  // ===========================================================================
  // HISTÓRICO
  // ===========================================================================

  @Get("chat/:id/history")
  async getHistory(@Param("id") id: string) {
    const chatId = typeof id === "string" ? id.trim() : ""
    if (!chatId) {
      throw new BadRequestException("chatId é obrigatório")
    }
    return this.service.getHistory(chatId)
  }

  // ===========================================================================
  // VISITA
  // ===========================================================================

  @Post("site-visit")
  @HttpCode(HttpStatus.CREATED)
  async recordVisit(
    @Body() body: { visitorKey?: string; pageUrl?: string },
    @Req() req: Request,
  ) {
    const visitorKey = typeof body.visitorKey === "string" ? body.visitorKey.trim().slice(0, 255) : undefined
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 4000) : undefined
    const referrer = typeof req.headers.referer === "string" ? req.headers.referer.slice(0, 4000) : undefined
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 2000) : undefined

    // Extrai IP (respeita X-Forwarded-For)
    const forwardedFor = req.headers["x-forwarded-for"]
    const remoteIp =
      typeof forwardedFor === "string"
        ? forwardedFor.split(",")[0]?.trim()
        : req.socket?.remoteAddress ?? ""

    return this.service.recordVisit({ visitorKey, pageUrl, referrer, userAgent, remoteIp })
  }

  // ===========================================================================
  // ONBOARDING
  // ===========================================================================

  @Post("onboarding/name")
  @HttpCode(HttpStatus.OK)
  async setVisitorName(@Body() body: { chatId?: string; nome?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const nome = typeof body.nome === "string" ? body.nome.trim() : ""

    if (!chatId || !nome) {
      throw new BadRequestException("chatId e nome são obrigatórios")
    }

    return this.service.setVisitorName(chatId, nome)
  }

  @Post("onboarding/email")
  @HttpCode(HttpStatus.OK)
  async startEmailVerification(@Body() body: { chatId?: string; email?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const email = typeof body.email === "string" ? body.email.trim() : ""

    if (!chatId || !email) {
      throw new BadRequestException("chatId e email são obrigatórios")
    }

    return this.service.startEmailVerification(chatId, email)
  }

  @Post("onboarding/verify")
  @HttpCode(HttpStatus.OK)
  async verifyEmailCode(
    @Body() body: { chatId?: string; email?: string; code?: string },
  ) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const email = typeof body.email === "string" ? body.email.trim() : ""
    const code = typeof body.code === "string" ? body.code.trim() : ""

    if (!chatId || !email || !code) {
      throw new BadRequestException("chatId, email e code são obrigatórios")
    }

    return this.service.verifyEmailCode(chatId, email, code)
  }

  @Post("onboarding/resend")
  @HttpCode(HttpStatus.OK)
  async resendVerificationCode(@Body() body: { chatId?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""

    if (!chatId) {
      throw new BadRequestException("chatId é obrigatório")
    }

    return this.service.resendVerificationCode(chatId)
  }

  @Post("onboarding/phone")
  @HttpCode(HttpStatus.OK)
  async setVisitorPhone(@Body() body: { chatId?: string; telefone?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const telefone = typeof body.telefone === "string" ? body.telefone.trim() : ""

    if (!chatId || !telefone) {
      throw new BadRequestException("chatId e telefone são obrigatórios")
    }

    return this.service.setVisitorPhone(chatId, telefone)
  }

  @Post("onboarding/finalize")
  @HttpCode(HttpStatus.OK)
  async finalizeOnboarding(@Body() body: { chatId?: string; descricao?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const descricao = typeof body.descricao === "string" ? body.descricao : undefined

    if (!chatId) {
      throw new BadRequestException("chatId é obrigatório")
    }

    return this.service.finalizeOnboarding(chatId, descricao)
  }

  // ===========================================================================
  // DEFINIÇÕES E PROJETO (fase de levantamento)
  // ===========================================================================

  @Post("definition")
  @HttpCode(HttpStatus.OK)
  async addDefinition(@Body() body: { chatId?: string; definition?: string; texto?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const texto =
      typeof body.definition === "string" && body.definition.trim()
        ? body.definition
        : typeof body.texto === "string"
          ? body.texto
          : ""

    if (!chatId || !texto.trim()) {
      throw new BadRequestException("chatId e definition são obrigatórios")
    }

    return this.service.addDefinition(chatId, texto)
  }

  @Post("definition/update")
  @HttpCode(HttpStatus.OK)
  async updateDefinition(
    @Body() body: { chatId?: string; id?: string | number; definition?: string; texto?: string },
  ) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const id = body.id !== undefined && body.id !== null ? String(body.id) : ""
    const texto =
      typeof body.definition === "string" && body.definition.trim()
        ? body.definition
        : typeof body.texto === "string"
          ? body.texto
          : ""

    if (!chatId || !id || !texto.trim()) {
      throw new BadRequestException("chatId, id e definition são obrigatórios")
    }

    return this.service.updateDefinition(chatId, id, texto)
  }

  @Post("project/name")
  @HttpCode(HttpStatus.OK)
  async setProjectName(@Body() body: { chatId?: string; projectName?: string; nome?: string }) {
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : ""
    const nome =
      typeof body.projectName === "string" && body.projectName.trim()
        ? body.projectName
        : typeof body.nome === "string"
          ? body.nome
          : ""

    if (!chatId || !nome.trim()) {
      throw new BadRequestException("chatId e projectName são obrigatórios")
    }

    return this.service.setProjectName(chatId, nome)
  }
}
