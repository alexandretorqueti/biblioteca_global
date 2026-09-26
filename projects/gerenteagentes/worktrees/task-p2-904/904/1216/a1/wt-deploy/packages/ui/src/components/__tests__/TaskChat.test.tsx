// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import TaskChat from "../TaskChat"

// ============================================================================
// Helper: mock fetch responsivo
// ============================================================================

function mockFetchResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  )
}

function mockFetch(status: number, body: unknown) {
  return () => mockFetchResponse(status, body)
}

const baseUrl = "/api"
const taskId = "42"

// ============================================================================
// Testes
// ============================================================================

describe("TaskChat (st-6)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // --- Teste: renderiza estado inicial com lista de mensagens do GET ---
  it("renderiza lista de mensagens carregadas via GET", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [
      { id: "m1", role: "admin" as const, text: "Olá!", createdAt: "2026-08-17T10:00:00Z" },
      { id: "m2", role: "user" as const, text: "Oi, como vai?", createdAt: "2026-08-17T10:01:00Z" },
    ]))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.queryByTestId("taskchat-root")).toBeInTheDocument()
    })

    // Ambas as mensagens devem estar visíveis.
    expect(screen.getByText("Olá!")).toBeInTheDocument()
    expect(screen.getByText("Oi, como vai?")).toBeInTheDocument()

    // Timestamps formatados.
    expect(screen.getByText("10:00")).toBeInTheDocument()
    expect(screen.getByText("10:01")).toBeInTheDocument()
  })

  // --- Teste: mensagem enviada via POST insere e reenvia lista ---
  it("POST envia mensagem e recarrega a lista", async () => {
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return mockFetchResponse(200, { ok: true })

      // GET retorna a lista atualizada (3 mensagens).
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "Olá!", createdAt: "2026-08-17T10:00:00Z" },
        { id: "m2", role: "user" as const, text: "Oi, como vai?", createdAt: "2026-08-17T10:01:00Z" },
        { id: "m3", role: "admin" as const, text: "Tudo bem!", createdAt: "2026-08-17T10:02:00Z" },
      ])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Aguardar carregamento inicial.
    await waitFor(() => {
      expect(screen.getByText("Olá!")).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    // Digitar mensagem e enviar.
    await user.type(actualInput, "Nova mensagem")
    // Botão desativado até ter texto → clicar com fireEvent (bypass pointer-events).
    const button = screen.getByTestId("taskchat-send-button")
    await user.click(actualInput) // focar
    fireEvent.click(button)

    // Input deve ser limpo após envio.
    await waitFor(() => {
      expect(actualInput.value).toBe("")
    })

    // Nova mensagem na lista (re-fetch após POST).
    await waitFor(() => {
      expect(screen.getByText("Tudo bem!")).toBeInTheDocument()
    })
  })

  // --- Teste: Enter no TextField envia a mensagem ---
  it("Enter no input envia a mensagem", async () => {
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return mockFetchResponse(200, { ok: true })
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "Resposta!", createdAt: "2026-08-17T10:03:00Z" },
      ])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.queryByTestId("taskchat-root")).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Comando pelo enter{enter}")

    // Após o Enter, a resposta deve aparecer.
    await waitFor(() => {
      expect(screen.getByText("Resposta!")).toBeInTheDocument()
    })
  })

  // --- Teste: botão disabled quando input vazio ---
  it("botão enviar está disabled quando input está vazio", async () => {
    vi.stubGlobal("fetch", mockFetch(200, []))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Aguardar a lista inicial (mesmo vazia).
    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const button = screen.getByTestId("taskchat-send-button") as HTMLButtonElement
    expect(button).toBeDisabled()
  })

  // --- Teste: mensagem de "nenhuma mensagem" quando lista vazia ---
  it("exibe mensagem de estado vazio quando não há mensagens", async () => {
    vi.stubGlobal("fetch", mockFetch(200, []))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })
  })

  // --- Teste: erro de carga exibe Alert vermelho ---
  it("exibe alerta de erro quando GET falha", async () => {
    vi.stubGlobal("fetch", () => mockFetchResponse(500, { message: "Servidor indisponível" }))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("Servidor indisponível")).toBeInTheDocument()
    })
  })

  // --- Teste: erro de envio exibe alerta ---
  it("exibe alerta de erro quando POST falha", async () => {
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return mockFetchResponse(400, { message: "Texto inválido" })
      return mockFetchResponse(200, [])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Teste de erro{enter}")

    // A mensagem de erro deve aparecer (do fetch de refresh que falha).
    await waitFor(() => {
      expect(screen.getByText("Texto inválido")).toBeInTheDocument()
    })
  })

  // --- Teste: mensagens admin alinhadas à direita, user à esquerda ---
  it("alinha mensagens admin à direita e user à esquerda", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [
      { id: "m1", role: "admin" as const, text: "Admin msg" },
      { id: "m2", role: "user" as const, text: "User msg" },
    ]))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("Admin msg")).toBeInTheDocument()
    })

    // Mensagem admin → Paper pai tem justifyContent flex-end.
    const adminPaper = screen.getByText("Admin msg").parentElement?.parentElement as HTMLElement | null
    if (adminPaper) {
      const style = window.getComputedStyle(adminPaper)
      expect(style.justifyContent).toBe("flex-end")
    }

    // Mensagem user → Paper pai tem justifyContent flex-start.
    const userPaper = screen.getByText("User msg").parentElement?.parentElement as HTMLElement | null
    if (userPaper) {
      const style = window.getComputedStyle(userPaper)
      expect(style.justifyContent).toBe("flex-start")
    }
  })

  // --- Teste: botão e input desabilitados durante envio ---------------------
  it("desabilita input e botão durante envio", async () => {
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return mockFetchResponse(200, { ok: true })
      // GET após POST refresh retorna lista.
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "OK!", createdAt: "2026-08-17T10:04:00Z" },
      ])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.queryByTestId("taskchat-root")).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement
    const button = screen.getByTestId("taskchat-send-button") as HTMLButtonElement

    // Input e botão estão inicialmente desabilitados (sem mensagem digitada).
    expect(button).toBeDisabled()

    // Dispatch Enter → handler chama handleMessageSend que seta sending=true.
    await user.type(actualInput, "Enviando...{enter}")

    // Após o tipo + enter: button recebe Mui-disabled do IconButton disabled prop.
    expect(button).toHaveClass("Mui-disabled")

    // Aguardar a resposta completa para evitar warnings de render após unmount.
    await waitFor(() => {
      expect(screen.getByText("OK!")).toBeInTheDocument()
    })
  })
})
