// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider, clearCustomScreens } from "@biblioteca-global/ui"

import NovaTarefaScreen from "../NovaTarefaScreen"

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn()

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

function mockError(status: number, body?: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => body ?? { code: "ERROR", message: `HTTP ${status}` },
  })
}

/* ------------------------------------------------------------------ */
/*  Testes                                                             */
/* ------------------------------------------------------------------ */

describe("NovaTarefaScreen", () => {
  let user: ReturnType<typeof userEvent.setup>

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    user = userEvent.setup()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearCustomScreens()
  })

  it("renderiza formulário com campos vazios e botão desabilitado", () => {
    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    expect(screen.getByTestId("nova-tarefa-screen")).toBeInTheDocument()
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("exibe botão enviar habilitado quando campos obrigatórios estão preenchidos", async () => {
    const API = "http://api.tarefas.localhost"
    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "1")
    expect(screen.getByTestId("btn-enviar")).toBeDisabled() // titulo ainda vazio

    await user.type(screen.getByTestId("input-titulo"), "Tarefa de teste")
    expect(screen.getByTestId("btn-enviar")).toBeEnabled() // ambos preenchidos
  })

  it("envia POST ao clicar em criar rascunho e exibe sucesso", async () => {
    mockOk({ id: 42, status: "rascunho" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "1")
    await user.type(screen.getByTestId("input-titulo"), "Minha tarefa")
    await user.type(screen.getByTestId("input-descricao"), "Descricao testando aqui")

    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "http://api.tarefas.localhost/api/task",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
          body: expect.any(String),
        })
      )

      const corpo = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(corpo.agenteId).toBe(1)
      expect(corpo.titulo).toBe("Minha tarefa")
      expect(corpo.descricao).toBe("Descricao testando aqui")
    })

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })
  })

  it("exibe aviso de 404 quando o motor retorna 404", async () => {
    mockError(404, { code: "NOT_FOUND", message: "Endpoint não encontrado" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "1")
    await user.type(screen.getByTestId("input-titulo"), "Tarefa 404")
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })

    // Mensagem menciona motor e /api/task
    expect(screen.getByTestId("api-error")).toHaveTextContent("/api/task")
  })

  it("exibe erro genérico para outros códigos HTTP", async () => {
    mockError(500, { code: "INTERNAL_SERVER_ERROR", message: "Erro interno" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "1")
    await user.type(screen.getByTestId("input-titulo"), "Tarefa erro")
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })
  })

  it("exibe erro de validação local quando campos obrigatórios estão vazios", async () => {
    mockOk({})

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    // Título preenchido, agente vazio → botão desabilitado
    await user.type(screen.getByTestId("input-titulo"), "Alguma tarefa")
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("limpa o formulário após sucesso", async () => {
    mockOk({ id: 99 })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "5")
    await user.type(screen.getByTestId("input-titulo"), "Tarefa para limpar")
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })

    // Botão deve estar habilitado novamente (campos vazios = desabilitado, mas o state foi limpo)
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("mostra loading no botão durante envio", async () => {
    // Promessa nunca resolve — o componente fica em "enviando"
    mockFetch.mockReturnValue(new Promise(() => {}))

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await user.type(screen.getByTestId("input-agente-id"), "1")
    await user.type(screen.getByTestId("input-titulo"), "Tarefa longa")

    // Botão deve estar desabilitado antes de clicar (nenhum erro de validação)
    expect(screen.getByTestId("btn-enviar")).not.toBeDisabled()

    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      const btn = screen.getByTestId("btn-enviar")
      expect(btn).toBeDisabled()
      // Texto do botão mudou para "Enviando..."
      expect(btn).toHaveTextContent(/Enviando/)
    })
  })
})
