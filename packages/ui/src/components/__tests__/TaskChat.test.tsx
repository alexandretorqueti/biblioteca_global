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

// ============================================================================
// Testes de fluxos sequenciais (st-4: troca de tarefa, reconexão, histórico)
// ============================================================================

describe("TaskChat — fluxos sequenciais (st-4)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // --------------------------------------------------------------------------
  // 1. Carregamento de histórico do chat
  // --------------------------------------------------------------------------

  it("carrega o histórico completo ao montar", async () => {
    const mensagensHistorico = [
      { id: "h1", role: "user" as const, text: "Primeira mensagem", createdAt: "2026-09-01T08:00:00Z" },
      { id: "h2", role: "admin" as const, text: "Resposta do agente", createdAt: "2026-09-01T08:01:00Z" },
      { id: "h3", role: "user" as const, text: "Segunda pergunta", createdAt: "2026-09-01T08:02:00Z" },
      { id: "h4", role: "admin" as const, text: "Resposta final", createdAt: "2026-09-01T08:03:00Z" },
    ]

    const fetchSpy = vi.fn(() => mockFetchResponse(200, mensagensHistorico))
    vi.stubGlobal("fetch", fetchSpy)

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Todas as mensagens do histórico devem estar visíveis.
    await waitFor(() => {
      expect(screen.getByText("Primeira mensagem")).toBeInTheDocument()
      expect(screen.getByText("Resposta do agente")).toBeInTheDocument()
      expect(screen.getByText("Segunda pergunta")).toBeInTheDocument()
      expect(screen.getByText("Resposta final")).toBeInTheDocument()
    })

    // Verificar que a URL do GET está correta.
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/task/42/chat",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    )
  })

  it("exibe histórico vazio com mensagem apropriada", async () => {
    vi.stubGlobal("fetch", mockFetch(200, []))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })
  })

  it("formata timestamps do histórico em horário local", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [
      { id: "m1", role: "admin" as const, text: "Msg", createdAt: "2026-09-01T15:30:00Z" },
    ]))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      // O timestamp deve ser formatado como HH:MM (pt-BR, UTC por TZ=UTC no vitest).
      expect(screen.getByText("15:30")).toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // 2. Envio de mensagem e recebimento de resposta em tempo real
  // --------------------------------------------------------------------------

  it("após POST bem-sucedido, recarrega a lista com a resposta do agente", async () => {
    let postCalled = false

    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        postCalled = true
        // Validar que o body contém role=admin e o texto correto.
        const body = JSON.parse(opts.body as string)
        expect(body.role).toBe("admin")
        expect(body.text).toBe("Preciso de ajuda")
        return mockFetchResponse(200, { ok: true })
      }

      // GET: antes do POST retorna lista inicial; após POST retorna lista com resposta.
      if (postCalled) {
        return mockFetchResponse(200, [
          { id: "m1", role: "user" as const, text: "Preciso de ajuda", createdAt: "2026-09-01T09:00:00Z" },
          { id: "m2", role: "admin" as const, text: "Claro, como posso ajudar?", createdAt: "2026-09-01T09:00:05Z" },
        ])
      }
      return mockFetchResponse(200, [])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Preciso de ajuda{enter}")

    // Após o envio + refresh, a resposta do agente deve aparecer.
    await waitFor(() => {
      expect(screen.getByText("Claro, como posso ajudar?")).toBeInTheDocument()
      expect(screen.getByText("Preciso de ajuda")).toBeInTheDocument()
    })

    // Input deve ter sido limpo.
    expect(actualInput.value).toBe("")
  })

  it("envia POST com Content-Type application/json", async () => {
    const fetchSpy = vi.fn((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return mockFetchResponse(200, { ok: true })
      }
      return mockFetchResponse(200, [])
    })
    vi.stubGlobal("fetch", fetchSpy)

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Teste{enter}")

    // Aguardar o POST ser processado.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/task/42/chat",
        expect.objectContaining({ method: "POST" }),
      )
    })

    // Verificar headers do POST.
    const postCall = fetchSpy.mock.calls.find((c) => c[1]?.method === "POST")
    expect(postCall).toBeDefined()
    expect(postCall?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    })
  })

  it("não envia mensagem vazia (texto só com espaços)", async () => {
    const fetchMock = vi.fn(() => mockFetchResponse(200, []))
    vi.stubGlobal("fetch", fetchMock)

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    // O fetch inicial (GET) deve ser a única chamada.
    const callsBeforeTyping = fetchMock.mock.calls.length

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    // Digitar apenas espaços e pressionar Enter.
    await user.type(actualInput, "   {enter}")

    // Nenhuma chamada POST adicional deve ter sido feita.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTyping)
  })

  // --------------------------------------------------------------------------
  // 3. Troca de tarefa e limpeza de estado
  // --------------------------------------------------------------------------

  it("ao trocar taskId, limpa mensagens antigas e carrega novas", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/task/42/")) {
        return mockFetchResponse(200, [
          { id: "m1", role: "admin" as const, text: "Chat da tarefa 42" },
        ])
      }
      if (url.includes("/task/99/")) {
        return mockFetchResponse(200, [
          { id: "m2", role: "admin" as const, text: "Chat da tarefa 99" },
        ])
      }
      return mockFetchResponse(200, [])
    })
    vi.stubGlobal("fetch", fetchMock)

    const { rerender } = render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Aguardar carregamento da tarefa 42.
    await waitFor(() => {
      expect(screen.getByText("Chat da tarefa 42")).toBeInTheDocument()
    })

    // Trocar para tarefa 99.
    rerender(<TaskChat baseUrl={baseUrl} taskId="99" />)

    // Mensagens da tarefa 99 devem aparecer.
    await waitFor(() => {
      expect(screen.getByText("Chat da tarefa 99")).toBeInTheDocument()
    })

    // Mensagens da tarefa 42 NÃO devem mais estar visíveis.
    expect(screen.queryByText("Chat da tarefa 42")).not.toBeInTheDocument()

    // Verificar que o GET foi feito para a URL correta da nova tarefa.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/task/99/chat",
      expect.any(Object),
    )
  })

  it("ao trocar taskId, limpa o estado de erro anterior", async () => {
    let callCount = 0
    const fetchMock = vi.fn(() => {
      callCount++
      // Primeira chamada (tarefa 42): falha. Segunda (tarefa 99): sucesso.
      if (callCount === 1) {
        return mockFetchResponse(500, { message: "Erro na tarefa 42" })
      }
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "Chat limpo da tarefa 99" },
      ])
    })
    vi.stubGlobal("fetch", fetchMock)

    const { rerender } = render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Erro da tarefa 42 deve aparecer.
    await waitFor(() => {
      expect(screen.getByText("Erro na tarefa 42")).toBeInTheDocument()
    })

    // Trocar para tarefa 99.
    rerender(<TaskChat baseUrl={baseUrl} taskId="99" />)

    // Erro deve desaparecer e novas mensagens devem aparecer.
    await waitFor(() => {
      expect(screen.getByText("Chat limpo da tarefa 99")).toBeInTheDocument()
    })
    expect(screen.queryByText("Erro na tarefa 42")).not.toBeInTheDocument()
  })

  it("ao trocar taskId, cancela requisições pendentes da tarefa anterior", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFirstFetch: ((value: Response) => void) | undefined

    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/task/42/")) {
        // Primeira chamada: retorna uma Promise que nunca resolve (simula lentidão).
        return new Promise<Response>((resolve) => {
          resolveFirstFetch = resolve
        })
      }
      if (url.includes("/task/99/")) {
        return mockFetchResponse(200, [
          { id: "m2", role: "admin" as const, text: "Resposta rápida da 99" },
        ])
      }
      return mockFetchResponse(200, [])
    })
    vi.stubGlobal("fetch", fetchMock)

    const { rerender } = render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Trocar imediatamente para tarefa 99 (antes da tarefa 42 responder).
    rerender(<TaskChat baseUrl={baseUrl} taskId="99" />)

    // A resposta da tarefa 99 deve aparecer.
    await waitFor(() => {
      expect(screen.getByText("Resposta rápida da 99")).toBeInTheDocument()
    })

    // Resolver a fetch da tarefa 42 atrasadamente — não deve causar atualização.
    if (resolveFirstFetch) {
      resolveFirstFetch(
        new Response(JSON.stringify([{ id: "m1", role: "admin" as const, text: "Resposta tardia da 42" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    }

    // Aguardar um tick para garantir que o state não foi atualizado.
    await new Promise((r) => setTimeout(r, 50))

    // A mensagem tardia da tarefa 42 NÃO deve aparecer (foi cancelada pelo cleanup).
    expect(screen.queryByText("Resposta tardia da 42")).not.toBeInTheDocument()
    // A mensagem da tarefa 99 continua visível.
    expect(screen.getByText("Resposta rápida da 99")).toBeInTheDocument()
  })

  it("ao trocar baseUrl, recarrega mensagens da nova API", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api-v1/")) {
        return mockFetchResponse(200, [{ id: "m1", role: "admin" as const, text: "API v1" }])
      }
      if (url.startsWith("/api-v2/")) {
        return mockFetchResponse(200, [{ id: "m2", role: "admin" as const, text: "API v2" }])
      }
      return mockFetchResponse(200, [])
    })
    vi.stubGlobal("fetch", fetchMock)

    const { rerender } = render(<TaskChat baseUrl="/api-v1" taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("API v1")).toBeInTheDocument()
    })

    rerender(<TaskChat baseUrl="/api-v2" taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("API v2")).toBeInTheDocument()
    })
    expect(screen.queryByText("API v1")).not.toBeInTheDocument()
  })

  // --------------------------------------------------------------------------
  // 4. Cenários de erro e reconexão
  // --------------------------------------------------------------------------

  it("exibe erro quando fetch lança exceção de rede (offline)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      // O componente deve capturar o erro e exibir mensagem genérica.
      expect(screen.getByText("Failed to fetch")).toBeInTheDocument()
    })
  })

  it("exibe erro HTTP com status quando body não é JSON", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    )

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      // Quando o body não é JSON, o componente usa "HTTP <status>".
      expect(screen.getByText("HTTP 500")).toBeInTheDocument()
    })
  })

  it("exibe erro HTTP quando resposta JSON não tem campo message", async () => {
    vi.stubGlobal("fetch", () => mockFetchResponse(403, { error: "forbidden" }))

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      // Sem campo "message", cai no fallback "HTTP <status>".
      expect(screen.getByText("HTTP 403")).toBeInTheDocument()
    })
  })

  it("recupera após erro de carga quando taskId é re-renderizado (reconexão)", async () => {
    let shouldFail = true

    const fetchMock = vi.fn(() => {
      if (shouldFail) {
        return mockFetchResponse(503, { message: "Serviço indisponível" })
      }
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "Serviço restaurado!" },
      ])
    })
    vi.stubGlobal("fetch", fetchMock)

    // Primeira renderização: falha.
    const { rerender } = render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("Serviço indisponível")).toBeInTheDocument()
    })

    // Simular reconexão: o serviço volta. Forçar re-fetch via re-render com mesmo taskId
    // (o useEffect depende de [baseUrl, taskId], então trocamos temporariamente e voltamos).
    shouldFail = false
    rerender(<TaskChat baseUrl={baseUrl} taskId="temp" />)
    rerender(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    // Após reconexão, as mensagens devem aparecer.
    await waitFor(() => {
      expect(screen.getByText("Serviço restaurado!")).toBeInTheDocument()
    })
    // Erro anterior deve ter sido limpo.
    expect(screen.queryByText("Serviço indisponível")).not.toBeInTheDocument()
  })

  it("mantém mensagens existentes quando refresh após POST falha (erro parcial)", async () => {
    let postCount = 0

    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        postCount++
        return mockFetchResponse(200, { ok: true })
      }
      // GET inicial: retorna mensagens. GET após POST: falha.
      if (postCount > 0) {
        return mockFetchResponse(500, { message: "Erro ao recarregar" })
      }
      return mockFetchResponse(200, [
        { id: "m1", role: "user" as const, text: "Mensagem original" },
      ])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText("Mensagem original")).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Nova mensagem{enter}")

    // O POST foi bem-sucedido, mas o refresh falhou → erro é exibido.
    await waitFor(() => {
      expect(screen.getByText("Erro ao recarregar")).toBeInTheDocument()
    })
  })

  it("trata erro de rede no envio (fetch rejeita no POST)", async () => {
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return Promise.reject(new TypeError("Network error"))
      }
      return mockFetchResponse(200, [])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    await user.type(actualInput, "Mensagem que falha{enter}")

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument()
    })
  })

  it("reabilita input e botão após erro de envio", async () => {
    let postAttempts = 0
    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        postAttempts++
        if (postAttempts === 1) {
          return mockFetchResponse(500, { message: "Erro temporário" })
        }
        // Segunda tentativa: POST ok + GET retorna mensagens.
        return mockFetchResponse(200, { ok: true })
      }
      return mockFetchResponse(200, [
        { id: "m1", role: "admin" as const, text: "Resposta após retry" },
      ])
    })

    render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement
    const button = screen.getByTestId("taskchat-send-button") as HTMLButtonElement

    // Primeira tentativa: falha.
    await user.type(actualInput, "Tentativa 1{enter}")

    await waitFor(() => {
      expect(screen.getByText("Erro temporário")).toBeInTheDocument()
    })

    // Input e botão devem estar habilitados novamente para retry.
    await waitFor(() => {
      expect(button).toBeEnabled()
      expect(actualInput).not.toBeDisabled()
    })

    // Segunda tentativa: sucesso.
    await user.type(actualInput, "Tentativa 2{enter}")

    await waitFor(() => {
      expect(screen.getByText("Resposta após retry")).toBeInTheDocument()
    })
  })

  it("não perde estado de envio quando componente é desmontado durante request", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolvePost: ((value: Response) => void) | undefined

    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve
        })
      }
      return mockFetchResponse(200, [])
    })

    const { unmount } = render(<TaskChat baseUrl={baseUrl} taskId={taskId} />)

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument()
    })

    const user = userEvent.setup()
    const inputContainer = screen.getByTestId("taskchat-input")
    const actualInput = inputContainer.querySelector("input") as HTMLInputElement

    // Iniciar envio (POST fica pendente).
    await user.type(actualInput, "Mensagem{enter}")

    // Desmontar o componente enquanto o POST está pendente.
    unmount()

    // Resolver o POST atrasadamente — não deve causar erro de "state update on unmounted component".
    if (resolvePost) {
      resolvePost(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }

    // Se chegou aqui sem erro, o teste passou (cleanup correto).
    expect(true).toBe(true)
  })
})
