// @vitest-environment node
/**
 * isa-chat.controller.spec.ts — Testes unitários do controller de chat da Isa.
 *
 * Valida:
 * - Validação de payload
 * - Delegação correta ao service
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { IsaChatController } from "../isa-chat.controller"
import type { IsaChatService } from "../isa-chat.service"

describe("IsaChatController", () => {
  let controller: IsaChatController
  let mockService: Partial<IsaChatService>

  beforeEach(() => {
    vi.clearAllMocks()

    mockService = {
      createSession: vi.fn(),
      sendMessage: vi.fn(),
      getHistory: vi.fn(),
      recordVisit: vi.fn(),
      setVisitorName: vi.fn(),
      startEmailVerification: vi.fn(),
      verifyEmailCode: vi.fn(),
      resendVerificationCode: vi.fn(),
      setVisitorPhone: vi.fn(),
      finalizeOnboarding: vi.fn(),
    }

    controller = new IsaChatController(mockService as IsaChatService)
  })

  describe("POST /session", () => {
    it("deve aceitar chatKey", async () => {
      vi.mocked(mockService.createSession!).mockResolvedValue({
        ok: true,
        chatId: "visitor-abc",
        existing: false,
      })

      const result = await controller.createSession({ chatKey: "visitor-abc" })

      expect(result.ok).toBe(true)
      expect(mockService.createSession).toHaveBeenCalledWith({
        chatKey: "visitor-abc",
        email: undefined,
        nome: undefined,
        agentId: undefined,
      })
    })

    it("deve aceitar email (modo legado)", async () => {
      vi.mocked(mockService.createSession!).mockResolvedValue({
        ok: true,
        chatId: "42",
        existing: true,
      })

      const result = await controller.createSession({
        email: "cliente@test.com",
        nome: "Cliente",
      })

      expect(result.ok).toBe(true)
      expect(mockService.createSession).toHaveBeenCalledWith({
        chatKey: undefined,
        email: "cliente@test.com",
        nome: "Cliente",
        agentId: undefined,
      })
    })

    it("deve rejeitar sem chatKey e sem email", async () => {
      await expect(controller.createSession({})).rejects.toThrow(BadRequestException)
    })

    it("deve limitar tamanho do chatKey", async () => {
      vi.mocked(mockService.createSession!).mockResolvedValue({
        ok: true,
        chatId: "x".repeat(255),
        existing: false,
      })

      await controller.createSession({ chatKey: "x".repeat(500) })

      expect(mockService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chatKey: "x".repeat(255),
        }),
      )
    })
  })

  describe("POST /chat/send", () => {
    it("deve aceitar mensagem com texto", async () => {
      vi.mocked(mockService.sendMessage!).mockResolvedValue({
        ok: true,
        messageId: "msg-123",
      })

      const result = await controller.sendMessage({
        chatId: "42",
        text: "Preciso de um sistema",
      })

      expect(result.ok).toBe(true)
      expect(mockService.sendMessage).toHaveBeenCalledWith({
        chatId: "42",
        text: "Preciso de um sistema",
        agentId: undefined,
        attachments: [],
      })
    })

    it("deve encaminhar o agentId para o serviço", async () => {
      vi.mocked(mockService.sendMessage!).mockResolvedValue({ ok: true })

      await controller.sendMessage({ chatId: "42", text: "Olá", agentId: "alpha" })

      expect(mockService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "alpha" }),
      )
    })

    it("deve aceitar mensagem com anexos", async () => {
      vi.mocked(mockService.sendMessage!).mockResolvedValue({ ok: true })

      await controller.sendMessage({
        chatId: "42",
        text: "Veja o anexo",
        attachments: [{ name: "briefing.pdf", size: "120 KB", mime: "application/pdf", base64: "..." }],
      })

      expect(mockService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [{ name: "briefing.pdf", size: "120 KB", mime: "application/pdf", base64: "..." }],
        }),
      )
    })

    it("deve rejeitar sem chatId", async () => {
      await expect(
        controller.sendMessage({ chatId: "", text: "mensagem" }),
      ).rejects.toThrow(BadRequestException)
    })

    it("deve rejeitar sem texto e sem anexos", async () => {
      await expect(
        controller.sendMessage({ chatId: "42", text: "" }),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("GET /chat/:id/history", () => {
    it("deve retornar histórico", async () => {
      vi.mocked(mockService.getHistory!).mockResolvedValue({
        ok: true,
        chatId: "42",
        messages: [],
        project: { name: null, definitions: [] },
        onboarding: { state: "novo", verified: false },
      })

      const result = await controller.getHistory("42")

      expect(result.ok).toBe(true)
      expect(mockService.getHistory).toHaveBeenCalledWith("42")
    })

    it("deve rejeitar chatId vazio", async () => {
      await expect(controller.getHistory("")).rejects.toThrow(BadRequestException)
    })
  })

  describe("POST /site-visit", () => {
    it("deve registrar visita", async () => {
      vi.mocked(mockService.recordVisit!).mockResolvedValue({ ok: true })

      const mockReq = {
        headers: {
          referer: "https://google.com",
          "user-agent": "Mozilla/5.0",
          "x-forwarded-for": "192.168.1.1, 10.0.0.1",
        },
        socket: { remoteAddress: "127.0.0.1" },
      }

      const result = await controller.recordVisit(
        { visitorKey: "visitor-abc", pageUrl: "https://isa.globaltecnologia.net/" },
        mockReq as never,
      )

      expect(result.ok).toBe(true)
      expect(mockService.recordVisit).toHaveBeenCalledWith(
        expect.objectContaining({
          visitorKey: "visitor-abc",
          pageUrl: "https://isa.globaltecnologia.net/",
          referrer: "https://google.com",
          userAgent: "Mozilla/5.0",
          remoteIp: "192.168.1.1",
        }),
      )
    })
  })

  describe("POST /onboarding/*", () => {
    it("deve registrar nome", async () => {
      vi.mocked(mockService.setVisitorName!).mockResolvedValue({ ok: true, chatId: "42" })

      const result = await controller.setVisitorName({ chatId: "42", nome: "João" })
      expect(result.ok).toBe(true)
    })

    it("deve rejeitar nome vazio", async () => {
      await expect(controller.setVisitorName({ chatId: "42", nome: "" })).rejects.toThrow(
        BadRequestException,
      )
    })

    it("deve iniciar verificação de email", async () => {
      vi.mocked(mockService.startEmailVerification!).mockResolvedValue({
        ok: true,
        expiresAt: new Date(),
      })

      const result = await controller.startEmailVerification({
        chatId: "42",
        email: "cliente@test.com",
      })
      expect(result.ok).toBe(true)
    })

    it("deve verificar código", async () => {
      vi.mocked(mockService.verifyEmailCode!).mockResolvedValue({ ok: true })

      const result = await controller.verifyEmailCode({
        chatId: "42",
        email: "cliente@test.com",
        code: "123456",
      })
      expect(result.ok).toBe(true)
    })

    it("deve reenviar código", async () => {
      vi.mocked(mockService.resendVerificationCode!).mockResolvedValue({ ok: true })

      const result = await controller.resendVerificationCode({ chatId: "42" })
      expect(result.ok).toBe(true)
    })

    it("deve registrar telefone", async () => {
      vi.mocked(mockService.setVisitorPhone!).mockResolvedValue({ ok: true, chatId: "42" })

      const result = await controller.setVisitorPhone({
        chatId: "42",
        telefone: "(11) 99999-8888",
      })
      expect(result.ok).toBe(true)
    })

    it("deve finalizar onboarding", async () => {
      vi.mocked(mockService.finalizeOnboarding!).mockResolvedValue({ ok: true, chatId: "42" })

      const result = await controller.finalizeOnboarding({ chatId: "42" })
      expect(result.ok).toBe(true)
    })
  })
})
