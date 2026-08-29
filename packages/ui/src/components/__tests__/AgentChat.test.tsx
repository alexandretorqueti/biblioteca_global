// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import AgentChat from "../AgentChat"
import type { AgentChatDataSource } from "@biblioteca-global/shared"

function createClient(): AgentChatDataSource {
  return {
    chatId: "chat-1",
    visitorKey: "visitor-1",
    startSession: async () => ({ chatId: "chat-1", existing: false }),
    loadHistory: async () => ({ chatId: "chat-1", messages: [] }),
    sendMessage: async () => ({ ok: true, messageId: "message-1" }),
  }
}

describe("AgentChat", () => {
  it("renderiza o agente e a saudação configurada", async () => {
    render(<AgentChat agent={{ id: "isa", name: "Isa", domain: "isa.example" }} client={createClient()} welcomeMessage="Olá, visitante!" />)
    await waitFor(() => expect(screen.getByText("Olá, visitante!")).toBeInTheDocument())
    expect(screen.getByText("Isa")).toBeInTheDocument()
    expect(screen.getByText("isa.example")).toBeInTheDocument()
  })

  it("mantém o botão desabilitado sem conteúdo", async () => {
    render(<AgentChat agent={{ id: "agente", name: "Agente" }} client={createClient()} />)
    await waitFor(() => expect(screen.getByText("Olá! Eu sou Agente. Como posso ajudar?")).toBeInTheDocument())
    expect(screen.getByLabelText("Enviar mensagem")).toBeDisabled()
  })

  it("permite personalizar cabeçalho, mensagens e painel adicional", async () => {
    const client = createClient()
    render(
      <AgentChat
        agent={{ id: "isa", name: "Isa" }}
        client={client}
        renderHeader={(agent) => <header>Header de {agent.name}</header>}
        renderMessage={(message) => <div data-testid="custom-message">{message.text}</div>}
        renderSidebar={({ agent: currentAgent }) => <div>Contexto de {currentAgent.name}</div>}
      />,
    )

    await waitFor(() => expect(screen.getByTestId("custom-message")).toBeInTheDocument())
    expect(screen.getByText("Header de Isa")).toBeInTheDocument()
    expect(screen.getByText("Contexto de Isa")).toBeInTheDocument()
  })
})
