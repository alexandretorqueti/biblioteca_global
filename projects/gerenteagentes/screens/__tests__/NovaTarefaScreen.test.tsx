// @vitest-environment jsdom
/**
 * Testes da NovaTarefaScreen — tela que cria uma tarefa no projeto
 * gerenteagentes via endpoint interno da plataforma (POST /api/tarefas).
 *
 * Histórico: esta tela já foi testada quando fazia fetch direto para a API do
 * motor (http://api.tarefas.localhost/api/task). O commit ddd99a2 a converteu
 * para o endpoint interno da plataforma. Estes testes validam o contrato
 * ATUAL (endpoint interno, campos projetoId/título/descrição — agente e
 * ambiente de execução migraram para projetos_captados, migration 0003),
 * validação local, tratamento de erro e limpeza pós-sucesso).
 *
 * Notas de implementação (2026-08-19):
 * - MUI 7: `TextField select` nativo renderiza as opções num Popover fechado
 *   (lista `role=option`), não no `<input type="hidden">` — `user.selectOptions`
 *   falha com "Value not found in options". A interação é: clicar no combobox
 *   (abre a lista) → clicar na opção.
 * - Vitest 4.1.10: `mockResolvedValueOnce`/`mockImplementationOnce` são
 *   consumidos pela PRIMEIRA chamada do mock (aqui, o GET de opções), mesmo
 *   após `mockImplementation` persistente — o POST não recebe o mock
 *   posicionado. Solução: UMA `mockImplementation` única que roteia por URL+
 *   method, com o resultado do POST controlado por uma variável mutável
 *   (`postResult`).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider, clearCustomScreens } from "@biblioteca-global/ui"

import NovaTarefaScreen from "../NovaTarefaScreen"

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn()

/**
 * Resultado do POST /api/tarefas — controlado por teste.
 * `"pending"` = o fetch nunca resolve (estado de loading).
 */
let postResult:
  | { ok: boolean; status: number; body: unknown }
  | "pending" = { ok: true, status: 200, body: { id: 42, status: "draft" } }

/**
 * Mock único do fetch, rotaciondo por URL + method:
 * - GET /api/projetos_captados → opções de projeto
 * - POST /api/tarefas → `postResult` (controlado por teste)
 *
 * Uma única `mockImplementation` persistente (sem `Once`): a tela pode refazer
 * o fetch de opções em qualquer re-render e a ordem dos responses do
 * `Promise.all` interna não importa.
 */
function instalarMockFetch() {
  mockFetch.mockImplementation(async (url: unknown, opts?: { method?: string }) => {
    const u = String(url)
    if (opts?.method === "POST" && u.includes("tarefas")) {
      if (postResult === "pending") return new Promise(() => {})
      return { ok: postResult.ok, status: postResult.status, json: async () => postResult.body }
    }
    if (u.includes("projetos")) {
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 640, nome: "Projeto Piloto", ativo: true }] }) }
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) }
  })
}

/* ------------------------------------------------------------------ */
/*  Helpers de interação                                               */
/* ------------------------------------------------------------------ */

/**
 * Localiza o `div role=combobox` do select MUI identificado por `testId`.
 * O combobox é a irmã anterior do `<input type="hidden">` no DOM do InputBase
 * do MUI. Usa o próprio elemento (sem `getByRole("combobox", {name})`) porque
 * a tela tem DOIS selects e a query por nome fica ambígua com um menu aberto.
 */
function comboboxDoCampo(testId: string): HTMLElement {
  const input = screen.getByTestId(testId)
  const combobox = input.previousElementSibling as HTMLElement | null
  if (!combobox) throw new Error("combobox do campo não encontrado: " + testId)
  return combobox
}

/** Fecha qualquer Popover de select ainda aberto (animação do MUI). */
async function fecharMenuAberto(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByRole("listbox")) await user.keyboard("{Escape}")
}

/**
 * Preenche os campos do formulário. Os selects MUI são operados por
 * click-combobox + click-opção (ver nota de implementação no cabeçalho).
 */
async function preencherCampos(
  user: ReturnType<typeof userEvent.setup>,
  valor: { projetoId?: string; titulo?: string; descricao?: string } = {},
) {
  if (valor.projetoId) {
    await user.click(comboboxDoCampo("input-projeto-id"))
    const alvo = screen.queryAllByRole("option").find((o) => o.getAttribute("data-value") === valor.projetoId)
    await user.click(alvo!)
  }
  if (valor.titulo) await user.type(screen.getByTestId("input-titulo"), valor.titulo)
  if (valor.descricao) await user.type(screen.getByTestId("input-descricao"), valor.descricao)
  await fecharMenuAberto(user)
}

/**
 * Clica no botão de enviar. Se o botão estiver sob o Popover ainda em
 * animação (`pointer-events: none`), força o clique via `dispatchEvent` —
 * o handler do React é o que o teste valida.
 */
async function clicarEnviar(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.getByTestId("btn-enviar")
  if (getComputedStyle(btn).pointerEvents === "none") {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    return
  }
  await user.click(btn)
}

/* ------------------------------------------------------------------ */
/*  Testes                                                             */
/* ------------------------------------------------------------------ */

describe("NovaTarefaScreen", () => {
  let user: ReturnType<typeof userEvent.setup>

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    postResult = { ok: true, status: 200, body: { id: 42, status: "draft" } }
    instalarMockFetch()
    user = userEvent.setup()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearCustomScreens()
  })

  it("renderiza formulário com campos vazios e botão desabilitado", async () => {
    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    // Aguarda o useEffect/carregarOpcoes resolver para evitar act() warning.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/gerenteagentes/projetos_captados",
        expect.any(Object),
      )
    })

    expect(screen.getByTestId("nova-tarefa-screen")).toBeInTheDocument()
    expect(screen.getByTestId("input-projeto-id")).toBeInTheDocument()
    expect(screen.getByTestId("input-titulo")).toBeInTheDocument()
    expect(screen.getByTestId("input-descricao")).toBeInTheDocument()
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("exibe botão enviar desabilitado enquanto falta campo obrigatório", async () => {
    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640" })
    expect(screen.getByTestId("btn-enviar")).toBeDisabled() // título ainda vazio

    await preencherCampos(user, { titulo: "Tarefa de teste" })
    expect(screen.getByTestId("btn-enviar")).toBeEnabled() // todos obrigatórios preenchidos
  })

  it("envia POST para /api/tarefas ao criar e exibe sucesso", async () => {
    postResult = { ok: true, status: 200, body: { id: 42, status: "draft" } }

    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, {
      projetoId: "640",
      titulo: "Minha tarefa",
      descricao: "Descricao testando aqui",
    })
    await clicarEnviar(user)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/gerenteagentes/tarefas",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
          body: expect.any(String),
        })
      )

      const chamadaPost = mockFetch.mock.calls.find(
        (c) => String(c[0]) === "/api/gerenteagentes/tarefas",
      )
      expect(chamadaPost).toBeDefined()
      const corpo = JSON.parse((chamadaPost![1] as { body: string }).body)
      expect(corpo.projetoId).toBe(640)
      expect(corpo.titulo).toBe("Minha tarefa")
      expect(corpo.descricao).toBe("Descricao testando aqui")
      expect(corpo.status).toBe("draft")
    })

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })
  })

  it("exibe erro quando o endpoint interno retorna 404", async () => {
    postResult = { ok: false, status: 404, body: { message: "Endpoint não encontrado" } }

    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640", titulo: "Tarefa de teste" })
    await clicarEnviar(user)

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })
    expect(screen.getByTestId("api-error")).toHaveTextContent("Endpoint não encontrado")
  })

  it("exibe erro genérico para outros códigos HTTP", async () => {
    postResult = { ok: false, status: 500, body: { message: "Erro interno" } }

    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640", titulo: "Tarefa de erro" })
    await clicarEnviar(user)

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })
    expect(screen.getByTestId("api-error")).toHaveTextContent("Erro interno")
  })

  it("habilita o botão quando projeto e título estão preenchidos", async () => {
    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640", titulo: "Alguma tarefa" })
    expect(screen.getByTestId("btn-enviar")).toBeEnabled()

    // Sem título → desabilitado de novo (limpar + digitar outro título e limpar
    // para garantir que o estado vazia o campo)
    await user.clear(screen.getByTestId("input-titulo"))
    await user.type(screen.getByTestId("input-titulo"), "x")
    await user.clear(screen.getByTestId("input-titulo"))
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("limpa o formulário após sucesso", async () => {
    postResult = { ok: true, status: 200, body: { id: 99 } }

    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640", titulo: "Tarefa para limpar", descricao: "Desc" })
    await clicarEnviar(user)

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })

    // Estado limpo → campos vazios → botão desabilitado de novo.
    // `input-titulo` está DIRETAMENTE no `<input>` (inputProps do TextField).
    expect(screen.getByTestId("input-titulo")).toHaveValue("")
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("mostra loading no botão durante envio", async () => {
    // Opções carregam; o POST nunca resolve — o componente fica em "enviando"
    postResult = "pending"

    await act(async () => {
      render(
        <BibliotecaThemeProvider>
          <NovaTarefaScreen />
        </BibliotecaThemeProvider>,
      )
    })

    await preencherCampos(user, { projetoId: "640", titulo: "Tarefa longa" })

    // Botão habilitado antes de clicar (nenhum erro de validação)
    expect(screen.getByTestId("btn-enviar")).not.toBeDisabled()

    await clicarEnviar(user)

    await waitFor(() => {
      const btn = screen.getByTestId("btn-enviar")
      expect(btn).toBeDisabled()
      expect(btn).toHaveTextContent(/Criando/)
    })
  })
})
