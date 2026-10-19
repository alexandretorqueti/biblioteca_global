// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import AgentChat from "../AgentChat"
import type { AgentChatDataSource, ChatMessage } from "@biblioteca-global/shared"

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

  it("oferece iniciar nova conversa quando configurado", async () => {
    const onNewConversation = vi.fn()
    render(<AgentChat agent={{ id: "isa", name: "Isa" }} client={createClient()} onNewConversation={onNewConversation} />)
    await waitFor(() => expect(screen.getByText("Olá! Eu sou Isa. Como posso ajudar?")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Nova conversa" }))
    expect(onNewConversation).toHaveBeenCalledOnce()
  })

  describe("saudação no merge do histórico (tarefa 1019)", () => {
    /** Cliente com histórico mutável: simula o servidor persistindo saudação e respostas. */
    function createStatefulClient(options: {
      initialHistory?: ChatMessage[]
      replyText?: string
    }): { client: AgentChatDataSource; history: ChatMessage[] } {
      const history: ChatMessage[] = [...(options.initialHistory ?? [])]
      let sequence = 0
      const nextId = () => `srv-${++sequence}`
      return {
        history,
        client: {
          chatId: "chat-1",
          visitorKey: "visitor-1",
          startSession: async () => ({ chatId: "chat-1", existing: true }),
          loadHistory: async () => ({ chatId: "chat-1", messages: [...history] }),
          sendMessage: async (text) => {
            history.push({ id: nextId(), role: "user", text })
            if (options.replyText) {
              history.push({ id: nextId(), role: "agent", text: options.replyText })
            }
            return { ok: true, messageId: nextId() }
          },
        },
      }
    }

    /** Textos das bolhas de mensagem na ordem do DOM (Typography body2). */
    function messageTexts(): string[] {
      return Array.from(
        screen.getByTestId("agent-chat-root").querySelectorAll("p.MuiTypography-body2"),
      )
        .map((node) => node.textContent ?? "")
        .filter((text) => text !== "Digitando…")
    }

    async function sendMessage(text: string) {
      await userEvent.type(screen.getByLabelText("Digite sua mensagem..."), text)
      await userEvent.click(screen.getByLabelText("Enviar mensagem"))
    }

    it("revisita com saudação persistida no servidor: após envio a saudação aparece exatamente uma vez e é a primeira mensagem", async () => {
      const welcome = "Olá, visitante!"
      const { client } = createStatefulClient({
        initialHistory: [{ id: "srv-welcome", role: "agent", text: welcome }],
        replyText: "Resposta da Isa",
      })
      render(<AgentChat agent={{ id: "isa", name: "Isa" }} client={client} welcomeMessage={welcome} />)
      await waitFor(() => expect(screen.getByText(welcome)).toBeInTheDocument())

      await sendMessage("Preciso de um sistema")
      await waitFor(() => expect(screen.getByText("Resposta da Isa")).toBeInTheDocument())

      // Reprodução do bug: a saudação local (id local-) não pode reaparecer no rodapé.
      expect(screen.getAllByText(welcome)).toHaveLength(1)
      expect(messageTexts()).toEqual([welcome, "Preciso de um sistema", "Resposta da Isa"])
      // Indicador de espera resolve quando a resposta real chega.
      expect(screen.queryByRole("progressbar", { name: "Agente respondendo" })).not.toBeInTheDocument()
    })

    it("histórico do servidor sem mensagem de agente mantém a saudação local visível", async () => {
      const welcome = "Olá, visitante!"
      const { client, history } = createStatefulClient({ initialHistory: [] })
      render(<AgentChat agent={{ id: "isa", name: "Isa" }} client={client} welcomeMessage={welcome} />)
      await waitFor(() => expect(screen.getByText(welcome)).toBeInTheDocument())

      await sendMessage("Oi")
      await waitFor(() => expect(history.some((m) => m.role === "user" && m.text === "Oi")).toBe(true))
      // Estado atual preservado: a mensagem local otimista do usuário é deduplicada
      // pelo texto do servidor; a saudação local permanece como única mensagem de agente.
      await waitFor(() => expect(messageTexts()).toEqual(["Oi", welcome]))

      // Sessão sem saudação persistida ⇒ placeholder local permanece, sem duplicar.
      expect(screen.getAllByText(welcome)).toHaveLength(1)
    })

    it("saudação do servidor com texto diferente do local (modo legado e-mail) não duplica nem fixa a saudação no rodapé", async () => {
      const localWelcome = "Olá, visitante!"
      const serverWelcome = "Olá, Alexandre! Sou a Isa, da Global Tecnologia."
      const { client } = createStatefulClient({
        initialHistory: [{ id: "srv-welcome", role: "agent", text: serverWelcome }],
        replyText: "Como posso ajudar?",
      })
      render(<AgentChat agent={{ id: "isa", name: "Isa" }} client={client} welcomeMessage={localWelcome} />)
      await waitFor(() => expect(screen.getByText(localWelcome)).toBeInTheDocument())

      await sendMessage("Quero um orçamento")
      await waitFor(() => expect(screen.getByText("Como posso ajudar?")).toBeInTheDocument())

      expect(screen.queryByText(localWelcome)).not.toBeInTheDocument()
      expect(screen.getAllByText(serverWelcome)).toHaveLength(1)
      expect(messageTexts()).toEqual([serverWelcome, "Quero um orçamento", "Como posso ajudar?"])
    })

    it("múltiplos envios não acumulam saudação local no rodapé", async () => {
      const welcome = "Olá, visitante!"
      const { client } = createStatefulClient({
        initialHistory: [{ id: "srv-welcome", role: "agent", text: welcome }],
        replyText: "Entendi, vou analisar.",
      })
      render(<AgentChat agent={{ id: "isa", name: "Isa" }} client={client} welcomeMessage={welcome} />)
      await waitFor(() => expect(screen.getByText(welcome)).toBeInTheDocument())

      await sendMessage("primeira")
      await waitFor(() => expect(screen.getByText("Entendi, vou analisar.")).toBeInTheDocument())
      await sendMessage("segunda")
      await waitFor(() => expect(screen.getAllByText("Entendi, vou analisar.")).toHaveLength(2))

      expect(screen.getAllByText(welcome)).toHaveLength(1)
      expect(messageTexts()[0]).toBe(welcome)
      expect(messageTexts().filter((text) => text === welcome)).toHaveLength(1)
    })
  })
})
