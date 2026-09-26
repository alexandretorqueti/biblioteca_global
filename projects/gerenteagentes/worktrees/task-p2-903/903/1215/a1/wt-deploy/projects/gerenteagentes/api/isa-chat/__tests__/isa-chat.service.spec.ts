// @vitest-environment node
/**
 * isa-chat.service.spec.ts — Testes unitários do serviço de chat da Isa.
 *
 * Mocks: ProjectDbFactory, IsaChatBridge, ConfigService.
 * Não depende de banco real, BFF real ou OpenClaw real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { IsaChatService, WELCOME_MESSAGE, isValidEmail, isValidBrPhone } from "../isa-chat.service"

// Mock do file-extract
vi.mock("@biblioteca-global/file-extract", () => ({
  extractTextFromFile: vi.fn().mockResolvedValue({ ok: true, text: "texto extraído", kind: "text" }),
}))

describe("IsaChatService", () => {
  let service: IsaChatService
  let mockDb: Record<string, unknown>
  let mockFactory: { obter: ReturnType<typeof vi.fn> }
  let mockBridge: {
    isConfigured: ReturnType<typeof vi.fn>
    resolveSession: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    history: ReturnType<typeof vi.fn>
  }
  let mockConfigService: { get: ReturnType<typeof vi.fn> }

  // Mock chainable query builder simplificado
  const createMockQueryBuilder = () => {
    const chain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      innerJoin: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          $returningId: vi.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    }
    // Encadeamento
    chain.select.mockReturnValue(chain)
    chain.from.mockReturnValue(chain)
    chain.where.mockReturnValue(chain)
    chain.innerJoin.mockReturnValue(chain)
    chain.orderBy.mockReturnValue(chain)
    return chain
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockDb = createMockQueryBuilder()
    mockFactory = { obter: vi.fn().mockResolvedValue(mockDb) }
    mockBridge = {
      isConfigured: vi.fn().mockReturnValue(true),
      resolveSession: vi.fn().mockResolvedValue({
        sessionKey: "agent:isa:test-session",
        existing: false,
      }),
      send: vi.fn().mockResolvedValue({ ok: true, messageId: "msg-123", retryable: false }),
      history: vi.fn().mockResolvedValue([]),
    }
    mockConfigService = {
      get: vi.fn().mockImplementation((key: string) => {
        const env: Record<string, string> = {
          ISA_PROJECT_ID: "640",
          ISA_AGENT_ID: "isa",
          ISA_VERIFICATION_SECRET: "test-secret",
        }
        return env[key]
      }),
    }

    service = new IsaChatService(
      mockFactory as never,
      mockBridge as never,
      mockConfigService as never,
    )
  })

  describe("isValidEmail", () => {
    it("deve aceitar email válido", () => {
      expect(isValidEmail("cliente@test.com")).toBe(true)
      expect(isValidEmail("nome.sobrenome@dominio.com.br")).toBe(true)
    })

    it("deve rejeitar email inválido", () => {
      expect(isValidEmail("email-invalido")).toBe(false)
      expect(isValidEmail("@semusuario.com")).toBe(false)
      expect(isValidEmail("semdominio@")).toBe(false)
    })
  })

  describe("isValidBrPhone", () => {
    it("deve aceitar telefone BR válido", () => {
      expect(isValidBrPhone("(11) 99999-8888")).toBe(true)
      expect(isValidBrPhone("11999998888")).toBe(true)
      expect(isValidBrPhone("(21) 3333-4444")).toBe(true)
    })

    it("deve rejeitar telefone inválido", () => {
      expect(isValidBrPhone("123")).toBe(false)
      expect(isValidBrPhone("abc")).toBe(false)
    })
  })

  describe("isBridgeConfigured", () => {
    it("deve retornar true quando bridge está configurada", () => {
      expect(service.isBridgeConfigured()).toBe(true)
    })

    it("deve retornar false quando bridge não está configurada", () => {
      mockBridge.isConfigured.mockReturnValue(false)
      expect(service.isBridgeConfigured()).toBe(false)
    })
  })

  describe("recordVisit", () => {
    it("deve registrar visita com IP como hash", async () => {
      const result = await service.recordVisit({
        visitorKey: "visitor-abc",
        pageUrl: "https://isa.globaltecnologia.net/",
        referrer: "https://google.com",
        userAgent: "Mozilla/5.0",
        remoteIp: "192.168.1.1",
      })

      expect(result.ok).toBe(true)
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it("deve registrar visita sem IP", async () => {
      const result = await service.recordVisit({
        visitorKey: "visitor-abc",
        pageUrl: "https://isa.globaltecnologia.net/",
      })

      expect(result.ok).toBe(true)
    })
  })

  describe("sendMessage - validações", () => {
    it("deve lançar erro sem chatId", async () => {
      await expect(service.sendMessage({ chatId: "", text: "mensagem" })).rejects.toThrow()
    })

    it("deve lançar erro sem texto e sem anexos", async () => {
      await expect(service.sendMessage({ chatId: "42", text: "" })).rejects.toThrow()
    })
  })

  describe("WELCOME_MESSAGE", () => {
    it("deve ser definida", () => {
      expect(WELCOME_MESSAGE).toBeDefined()
      expect(WELCOME_MESSAGE).toContain("Isa")
    })
  })
})
