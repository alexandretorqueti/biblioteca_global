// @vitest-environment node
/**
 * isa-chat.service.spec.ts — Testes unitários do serviço de chat da Isa.
 *
 * Mocks: ProjectDbFactory, IsaChatBridge, ConfigService.
 * Não depende de banco real, BFF real ou OpenClaw real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { IsaChatService, getWelcomeMessage, isValidEmail, isValidBrPhone } from "../isa-chat.service"

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
    const chain: Record<string, unknown> = {
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
    ;(chain.select as ReturnType<typeof vi.fn>).mockReturnValue(chain)
    ;(chain.from as ReturnType<typeof vi.fn>).mockReturnValue(chain)
    ;(chain.where as ReturnType<typeof vi.fn>).mockReturnValue(chain)
    ;(chain.innerJoin as ReturnType<typeof vi.fn>).mockReturnValue(chain)
    ;(chain.orderBy as ReturnType<typeof vi.fn>).mockReturnValue(chain)
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

  describe("getWelcomeMessage", () => {
    it("deve retornar saudação da Isa por padrão", () => {
      const msg = getWelcomeMessage("isa")
      expect(msg).toBeDefined()
      expect(msg).toContain("Isa")
    })

    it("deve retornar saudação da Alpha para o agente alpha", () => {
      const msg = getWelcomeMessage("alpha")
      expect(msg).toContain("Alpha")
    })
  })

  // ===========================================================================
  // DEFINIÇÕES E FECHAMENTO DA CAPTAÇÃO
  // ===========================================================================

  const chatVerificado = {
    id: 42,
    contatoId: 5,
    projetoId: null,
    nomeProjeto: "Meu Sistema",
    chatKey: "nav-abc",
    sessionKey: null,
    status: "verificado",
  }

  describe("addDefinition", () => {
    it("deve registrar definição no buffer do chat", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([chatVerificado])

      const result = await service.addDefinition("42", "O sistema terá login por email")

      expect(result.ok).toBe(true)
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it("deve recusar definição sem identidade verificada", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { ...chatVerificado, contatoId: null },
      ])

      const result = await service.addDefinition("42", "definição qualquer")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("not_verified")
    })

    it("deve recusar chat inexistente", async () => {
      const result = await service.addDefinition("999", "definição")

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("chat_not_found")
    })
  })

  describe("updateDefinition", () => {
    it("deve atualizar definição do buffer do chat", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([chatVerificado]) // findChat
        .mockResolvedValueOnce([{ id: 10, chatId: 42, projetoId: null }]) // definição (findDef)

      const result = await service.updateDefinition("42", "10", "texto novo")

      expect(result.ok).toBe(true)
    })

    it("deve recusar definição de outro chat", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([chatVerificado])
        .mockResolvedValueOnce([{ id: 10, chatId: 999, projetoId: null }])

      const result = await service.updateDefinition("42", "10", "texto novo")

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("definition_not_found")
    })
  })

  describe("setProjectName", () => {
    it("deve gravar nome do projeto no chat", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([chatVerificado])

      const result = await service.setProjectName("42", "Meu Sistema")

      expect(result.ok).toBe(true)
      expect(mockDb.update).toHaveBeenCalled()
    })
  })

  describe("finalizeOnboarding", () => {
    it("deve criar projeto com descrição da Isa e vincular definições", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([chatVerificado]) // findChat
        .mockResolvedValueOnce([{ texto: "Definição 1" }, { texto: "Definição 2" }]) // buffer
        .mockResolvedValueOnce([]) // checagem de slug (sem colisão)

      const result = await service.finalizeOnboarding("42", "Descrição completa redigida pela Isa")

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.slug).toBe("meu-sistema")
        expect(result.projetoId).toBe("1")
      }
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it("deve usar fallback numerado quando a Isa não envia descrição", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([chatVerificado]) // findChat
        .mockResolvedValueOnce([{ texto: "Definição 1" }]) // buffer
        .mockResolvedValueOnce([]) // checagem de slug

      const result = await service.finalizeOnboarding("42")

      expect(result.ok).toBe(true)
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it("deve recusar sem identidade verificada", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { ...chatVerificado, contatoId: null },
      ])

      const result = await service.finalizeOnboarding("42")

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("not_verified")
    })

    it("deve exigir nome do projeto aprovado", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { ...chatVerificado, nomeProjeto: null },
      ])

      const result = await service.finalizeOnboarding("42")

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("project_name_required")
    })

    it("deve exigir ao menos uma definição", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([chatVerificado]) // findChat
        .mockResolvedValueOnce([]) // buffer vazio

      const result = await service.finalizeOnboarding("42")

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("no_definitions")
    })

    it("deve ser idempotente quando o projeto já existe", async () => {
      ;(mockDb.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { ...chatVerificado, projetoId: 7 },
      ])

      const result = await service.finalizeOnboarding("42", "nova descrição")

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.projetoId).toBe("7")
      // Não deve criar outro projeto.
      expect(mockDb.insert).not.toHaveBeenCalled()
    })
  })
})
