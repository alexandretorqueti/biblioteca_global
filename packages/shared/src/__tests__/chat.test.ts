import { describe, expect, it } from "vitest"
import {
  agentInfoSchema,
  chatHistorySchema,
  sendChatMessageInputSchema,
  sendChatMessageResultSchema,
  startChatSessionInputSchema,
} from "../index.js"

describe("contratos do chat com agentes", () => {
  it("aceita uma identidade de agente configurável", () => {
    const result = agentInfoSchema.safeParse({
      id: "isa",
      name: "Isa",
      domain: "isa.globaltecnologia.net",
      avatarUrl: "/isa.png",
    })

    expect(result.success).toBe(true)
  })

  it("aceita sessão, mensagem e anexo de entrada", () => {
    const session = startChatSessionInputSchema.safeParse({
      visitorKey: "visitor-123",
      agentId: "isa",
    })
    const message = sendChatMessageInputSchema.safeParse({
      chatId: "chat-123",
      text: "Preciso de um sistema",
      attachments: [
        {
          name: "briefing.pdf",
          size: "120 KB",
          mime: "application/pdf",
          base64: "cGRm",
        },
      ],
    })

    expect(session.success).toBe(true)
    expect(message.success).toBe(true)
  })

  it("aceita histórico com data ISO e rejeita contrato desconhecido", () => {
    const history = chatHistorySchema.safeParse({
      chatId: "chat-123",
      messages: [
        {
          id: "message-1",
          role: "agent",
          text: "Olá!",
          createdAt: "2026-08-29T10:00:00.000Z",
        },
      ],
    })
    const invalid = chatHistorySchema.safeParse({
      chatId: "chat-123",
      messages: [],
      unknownField: true,
    })

    expect(history.success).toBe(true)
    expect(invalid.success).toBe(false)
  })

  it("distingue sucesso, erro offline e erro não repetível", () => {
    expect(
      sendChatMessageResultSchema.safeParse({
        ok: true,
        messageId: "message-1",
      }).success,
    ).toBe(true)
    expect(
      sendChatMessageResultSchema.safeParse({
        ok: false,
        reason: "offline",
        retryable: true,
      }).success,
    ).toBe(true)
    expect(
      sendChatMessageResultSchema.safeParse({
        ok: false,
        reason: "http_error",
        retryable: false,
      }).success,
    ).toBe(true)
  })

  it("rejeita texto e identificadores vazios", () => {
    expect(
      sendChatMessageInputSchema.safeParse({ chatId: "", text: "oi" }).success,
    ).toBe(false)
    expect(
      sendChatMessageInputSchema.safeParse({ chatId: "chat-1", text: "" }).success,
    ).toBe(true)
    expect(
      startChatSessionInputSchema.safeParse({ visitorKey: "", agentId: "isa" }).success,
    ).toBe(false)
  })
})
