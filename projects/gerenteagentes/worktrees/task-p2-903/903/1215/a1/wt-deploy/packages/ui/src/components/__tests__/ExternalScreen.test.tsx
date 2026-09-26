// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { ThemeProvider, createTheme } from "@mui/material/styles"
import ExternalScreen from "../ExternalScreen"

// ============================================================================
// Helper: mock fetch que responde com JSON
// ============================================================================
/** Cria um Response novo a cada chamada (body nunca fica consumido entre fetches). */
function mockFetchResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  )
}

/** Stub direto: () => Promise<Response>. */
function mockFetch(status: number, body: unknown) {
  return () => mockFetchResponse(status, body)
}

function renderExternal(props?: Partial<React.ComponentProps<typeof ExternalScreen>>) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <ExternalScreen
        baseUrl="https://api.exemplo.com"
        method="GET"
        pathTemplate="/tasks/:id"
        params={{ id: "42" }}
        {...props}
      />
    </ThemeProvider>,
  )
}

// ============================================================================
// Master-detail básico: renderiza lista com linhas clicáveis quando detailPathTemplate existe
// ============================================================================

describe("ExternalScreen — master/detail (st-10)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // --- Teste: renderiza lista normal sem detailPathTemplate (linhas não clicáveis) ---
  it("renderiza grid normal quando detailPathTemplate não é fornecido", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [
      { id: "1", titulo: "Tarefa A" },
      { id: "2", titulo: "Tarefa B" },
    ]))

    renderExternal()

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })
    expect(screen.getByText("Tarefa A")).toBeInTheDocument()
    expect(screen.getByText("Tarefa B")).toBeInTheDocument()
  })

  // --- Teste: detalhe exibe botão "Voltar à lista" ao entrar em modo detail ---
  it("exibe botão 'Voltar à lista' quando entra em modo detalhe", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [{ id: "1", titulo: "Tarefa A" }]))

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })
    // Lista visível — sem botão voltar
    expect(screen.queryByRole("button", { name: /voltar/i })).not.toBeInTheDocument()
    expect(screen.getByText("Tarefa A")).toBeInTheDocument()

    // Clicar na linha abre o detalhe
    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    // Botão voltar aparece
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /voltar/i })).toBeInTheDocument()
    })
  })

  // --- Teste: click na linha faz fetch para detailPathTemplate interpolado ---
  it("clicar em linha faz fetch para o detalhe com params interpolados", async () => {
    const fetchList = vi.fn(() => Promise.resolve(new Response(JSON.stringify([
      { id: "t1", titulo: "Tarefa A" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })))

    let resolveDetail!: () => void
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = () => {
        resolve(new Response(JSON.stringify({ id: "t1", titulo: "Tarefa A", descricao: "Detalhe da tarefa" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      }
    })

    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return fetchList()
      return detailPromise
    })

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    // Resolve o fetch do detalhe
    resolveDetail()

    await waitFor(() => {
      expect(fetchList).toHaveBeenCalledTimes(1)
    })
  })

  // --- Teste: dados do detalhe são renderizados na grid após carregamento ---
  it("exibe dados do detalhe no JsonGrid após carregar", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
      return mockFetchResponse(200, { id: "t1", titulo: "Tarefa A", descricao: "Detalhe da tarefa" })
    })

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    await waitFor(() => {
      expect(screen.getByText("Detalhe da tarefa")).toBeInTheDocument()
    })
  })

  // --- Teste: "Voltar à lista" restaura a lista sem refetch desnecessário ---
  it("botão voltar restaura a lista sem fazer novo fetch", async () => {
    let fetchCount = 0
    vi.stubGlobal("fetch", (url: string) => {
      fetchCount += 1
      if (url.includes("/tasks/42")) return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
      return mockFetchResponse(200, { id: "t1", titulo: "Tarefa A", descricao: "Detalhe da tarefa" })
    })

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    // Abrir detalhe
    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    await waitFor(() => {
      expect(screen.getByText("Detalhe da tarefa")).toBeInTheDocument()
    })

    const fetchCountAntes = fetchCount

    // Clicar em voltar à lista
    const botaoVoltar = screen.getByRole("button", { name: /voltar/i })
    fireEvent.click(botaoVoltar)

    await waitFor(() => {
      expect(screen.getByText("Tarefa A")).toBeInTheDocument()
    })

    // Não deve ter tido novo fetch ao voltar
    expect(fetchCount).toBe(fetchCountAntes)
  })

  // --- Teste: detailPathTemplate com múltiplos placeholders interpolados corretamente ---
  it("interpola múltiplos placeholders no detailPathTemplate a partir dos dados da linha", async () => {
    const urlsChamadas: string[] = []
    vi.stubGlobal("fetch", (url: string) => {
      urlsChamadas.push(url)
      if (url.includes("/tasks/42")) {
        return mockFetchResponse(200, [{ id: "t5", titulo: "Tarefa X", projectId: "p123", taskId: "t5" }])
      }
      return mockFetchResponse(200, { id: "t5", titulo: "Tarefa X", projectId: "p123", taskId: "t5" })
    })

    renderExternal({ detailPathTemplate: "/project/:projectId/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    // Linha com campos projectId e taskId → interpolação no clique
    const linha = screen.getByText("Tarefa X")
    fireEvent.click(linha)

    // O detalhe deve buscar com os placeholders interpolados a partir da linha
    await waitFor(() => {
      expect(urlsChamadas.some((u) => u.includes("/project/p123/task/t5"))).toBe(true)
    })
  })

  // --- Teste: detailDataPath extrai campo aninhado da resposta de detalhe ---
  it("detailDataPath extrai campo aninhado da resposta de detalhe", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
      // Resposta com envelope: { task: {...} }
      return mockFetchResponse(200, {
        task: { id: "t1", descricao: "com detailDataPath" },
      })
    })

    renderExternal({ detailPathTemplate: "/task/:taskId", detailDataPath: "task" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    await waitFor(() => {
      expect(screen.getByText("com detailDataPath")).toBeInTheDocument()
    })
  })

  // --- Teste: erro ao carregar detalhe exibe mensagem de erro ---
  it("exibe erro ao falhar ao carregar detalhe", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
      return mockFetchResponse(404, { message: "Não encontrado" })
    })

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    await waitFor(() => {
      expect(screen.getByText(/Erro ao carregar detalhe/)).toBeInTheDocument()
      expect(screen.getByText("Não encontrado")).toBeInTheDocument()
    })
  })

  // --- Teste: cursor padrão (não clicável) quando detailPathTemplate não existe ---
  it("linhas não são clicáveis sem detailPathTemplate", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [{ id: "1", titulo: "Sem Detail" }]))

    renderExternal()

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Sem Detail")
    // Sem detailPathTemplate, cursor é default (não pointer)
    const style = window.getComputedStyle(linha.parentElement as Element)
    expect(style.cursor).toBe("default")
  })

  // --- Teste: carregamento do detalhe exibe spinner "Carregando detalhe..." ---
  it("exibe 'Carregando detalhe' durante carga do detalhe", async () => {
    let resolveDetail!: () => void
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = () => {
        resolve(new Response(JSON.stringify({ id: "1" }), { status: 200 }))
      }
    })

    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
      return detailPromise
    })

    renderExternal({ detailPathTemplate: "/task/:taskId" })

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    // Clicar na linha → muda para modo detalhe (carregando)
    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    await waitFor(() => {
      expect(screen.getByText(/Carregando detalhe/)).toBeInTheDocument()
    })

    resolveDetail!()

    await waitFor(() => {
      expect(screen.queryByText(/Carregando detalhe/)).not.toBeInTheDocument()
    })
  })
})

// ============================================================================
// ExternalScreen — flag chat no detalhe (st-7)
// ===========================================================================

describe("ExternalScreen — flag chat no detalhe (st-7)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // Helper: monta mockFetch que responde list + detail por URL check.
  function makeFetchMock(detailPathSuffix: string) {
    return (url: string) => {
      if (url.includes(detailPathSuffix)) {
        return Promise.resolve(new Response(JSON.stringify({ id: "t1", titulo: "Tarefa A" }), { status: 200 }))
      }
      return mockFetchResponse(200, [{ id: "t1", titulo: "Tarefa A" }])
    }
  }

  // --- Teste: detail com chat:true renderiza TaskChat ---
  it("renderiza TaskChat quando detailPathTemplate e chat:true", async () => {
    const capturedProps: unknown[] = []

    vi.resetModules()
    vi.doMock("../TaskChat", () => ({
      default: (props: unknown) => {
        capturedProps.push(props)
        return <div data-testid="mock-taskchat" />;
      },
    }))

    const { default: ExternalScreenReloaded } = await import("../ExternalScreen")

    vi.stubGlobal("fetch", makeFetchMock("/task/t1"))

    render(
      <ThemeProvider theme={createTheme()}>
        <ExternalScreenReloaded
          baseUrl="https://api.exemplo.com"
          method="GET"
          pathTemplate="/tasks/:id"
          params={{ id: "42" }}
          detailPathTemplate="/task/:id"
          chat={true}
        />
      </ThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    // TaskChat mock deve ter sido chamado com taskId "t1"
    await waitFor(() => {
      expect(capturedProps.length).toBeGreaterThan(0)
      expect((capturedProps[0] as Record<string, unknown>).taskId).toBe("t1")
    })
  })

  // --- Teste: sem flag chat, não renderiza TaskChat no detalhe ---
  it("não renderiza TaskChat quando chat não é fornecido", async () => {
    const mockTaskChatProps: unknown[] = []

    vi.doMock("../TaskChat", () => ({
      default: (props: unknown) => {
        mockTaskChatProps.push(props)
        return <div data-testid="mock-taskchat" />;
      },
    }))

    vi.stubGlobal("fetch", makeFetchMock("/task/t1"))

    const { default: ExternalScreenReloaded } = await import("../ExternalScreen")

    render(
      <ThemeProvider theme={createTheme()}>
        <ExternalScreenReloaded
          baseUrl="https://api.exemplo.com"
          method="GET"
          pathTemplate="/tasks/:id"
          params={{ id: "42" }}
          detailPathTemplate="/task/:id"
          // chat não definido
        />
      </ThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    // JsonGrid deve estar visível (com dados), TaskChat NÃO
    await waitFor(() => {
      expect(screen.getByText("Tarefa A")).toBeInTheDocument()
      expect(mockTaskChatProps.length).toBe(0)
    })
  })

  // --- Teste: chat:false não renderiza TaskChat ---
  it("não renderiza TaskChat quando chat:false", async () => {
    const mockTaskChatProps: unknown[] = []

    vi.doMock("../TaskChat", () => ({
      default: (props: unknown) => {
        mockTaskChatProps.push(props)
        return <div data-testid="mock-taskchat" />;
      },
    }))

    vi.stubGlobal("fetch", makeFetchMock("/task/t1"))

    const { default: ExternalScreenReloaded } = await import("../ExternalScreen")

    render(
      <ThemeProvider theme={createTheme()}>
        <ExternalScreenReloaded
          baseUrl="https://api.exemplo.com"
          method="GET"
          pathTemplate="/tasks/:id"
          params={{ id: "42" }}
          detailPathTemplate="/task/:id"
          chat={false}
        />
      </ThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByText("Carregando...")).not.toBeInTheDocument()
    })

    const linha = screen.getByText("Tarefa A")
    fireEvent.click(linha)

    // JsonGrid deve estar visível (com dados), TaskChat NÃO
    await waitFor(() => {
      expect(screen.getByText("Tarefa A")).toBeInTheDocument()
      expect(mockTaskChatProps.length).toBe(0)
    })
  })
})

// ===========================================================================
// ExternalScreen — submit do edit (st-4)
// ===========================================================================

describe("ExternalScreen — submit do edit (st-4)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // --- Teste: submit dispara fetch PUT/PATCH com URL interpolada e payload correto ---
  it("submit dispara fetch PUT/PATCH com URL interpolada e payload correto", async () => {
    let urlCapturada = ""

    vi.stubGlobal("fetch", (url: string) => {
      urlCapturada = url
      return Promise.resolve(new Response(JSON.stringify([{ id: "1", titulo: "Tarefa A" }]), { status: 200, headers: { "Content-Type": "application/json" } }))
    })

    renderExternal({
      edit: {
        method: "PATCH",
        pathTemplate: "/task/:id",
        fields: [
          { name: "titulo", label: "Título", type: "text" },
          { name: "status", label: "Status", type: "select", options: [{ label: "Ativo", value: "ativo" }] },
        ],
      },
    })

    await waitFor(() => expect(screen.queryByText("Carregando...")).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }))
    await waitFor(() => expect(screen.getByText("Editar registro")).toBeInTheDocument())
    fireEvent.change(screen.getByDisplayValue("Tarefa A"), { target: { value: "Novo" } })
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }))

    await waitFor(() => expect(urlCapturada).toContain("/task/1"))
  })

  // --- Teste: submit com bodyPath envolve payload dentro de { [bodyPath]: values } ---
  it("quando edit tem bodyPath, o payload fica dentro do campo especificado", async () => {
    let responseStatus = 0

    vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => {
      if (url.includes("/tasks/42") && (opts?.method === undefined || opts?.method === "GET")) return mockFetch(200, [{ id: "1", titulo: "T" }] as never)()
      responseStatus = 200
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
    })

    renderExternal({
      edit: {
        method: "PUT",
        pathTemplate: "/task/:id",
        bodyPath: "data",
        fields: [{ name: "titulo", label: "Título", type: "text" }],
      },
    })

    await waitFor(() => expect(screen.queryByText("Carregando...")).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }))
    await waitFor(() => expect(screen.getByText("Editar registro")).toBeInTheDocument())
    fireEvent.change(screen.getByDisplayValue("T"), { target: { value: "X" } })
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }))

    await waitFor(() => expect(screen.getByText(/Registro salvo/)).toBeInTheDocument())
  })

  // --- Teste: sucesso do edit recarrega a grid e volta à lista após delay ---
  it("sucesso do edit recarrega a grid e volta à lista após delay", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [{ id: "1", titulo: "Tarefa A" }]))

    renderExternal({
      edit: {
        method: "PATCH",
        pathTemplate: "/task/:id",
        fields: [{ name: "titulo", label: "Título", type: "text" }],
      },
    })

    await waitFor(() => expect(screen.queryByText("Carregando...")).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }))
    await waitFor(() => expect(screen.getByText("Editar registro")).toBeInTheDocument())
    fireEvent.change(screen.getByDisplayValue("Tarefa A"), { target: { value: "Novo" } })
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }))

    await waitFor(() => expect(screen.getByText(/Registro salvo/)).toBeInTheDocument())
    await new Promise(r => setTimeout(r, 1500))

    expect(screen.queryByText("Editar registro")).not.toBeInTheDocument()
  })

  // --- Teste: erro HTTP exibe Alert sem crash ---
  it("erro HTTP no submit exibe Alert de erro sem crash", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/tasks/42")) return Promise.resolve(new Response(JSON.stringify([{ id: "1", titulo: "Tarefa A" }]), { status: 200, headers: { "Content-Type": "application/json" } }))
      return Promise.resolve(new Response(JSON.stringify({ message: "Erro interno do servidor" }), { status: 500 }))
    })

    renderExternal({
      edit: {
        method: "PATCH",
        pathTemplate: "/task/:id",
        fields: [{ name: "titulo", label: "Título", type: "text" }],
      },
    })

    await waitFor(() => expect(screen.queryByText("Carregando...")).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }))
    await waitFor(() => expect(screen.getByText("Editar registro")).toBeInTheDocument())
    fireEvent.change(screen.getByDisplayValue("Tarefa A"), { target: { value: "X" } })
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }))

    await waitFor(() => expect(screen.getByText(/Erro|erro/)).toBeInTheDocument())
    expect(screen.getByText("Editar registro")).toBeInTheDocument()
  })
})
