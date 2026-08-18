// @vitest-environment jsdom
/**
 * Testes da NovaTarefaScreen — tela que cria uma tarefa no projeto
 * gerenteagentes via endpoint interno da plataforma (POST /api/tarefas).
 *
 * Histórico: esta tela já foi testada quando fazia fetch direto para a API do
 * motor (http://api.tarefas.localhost/api/task). O commit ddd99a2 a converteu
 * para o endpoint interno da plataforma. Estes testes validam o contrato
 * ATUAL (endpoint interno, campos projetoId/agenteId/título/descrição,
 * validação local, tratamento de erro e limpeza pós-sucesso).
 */
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
    json: async () => body ?? { message: `HTTP ${status}` },
  })
}

async function preencherCampos(
  user: ReturnType<typeof userEvent.setup>,
  valor: { projetoId?: string; agenteId?: string; titulo?: string; descricao?: string } = {},
) {
  if (valor.projetoId) await user.type(screen.getByTestId("input-projeto-id"), valor.projetoId)
  if (valor.agenteId) await user.type(screen.getByTestId("input-agente-id"), valor.agenteId)
  if (valor.titulo) await user.type(screen.getByTestId("input-titulo"), valor.titulo)
  if (valor.descricao) await user.type(screen.getByTestId("input-descricao"), valor.descricao)
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
    expect(screen.getByTestId("input-projeto-id")).toBeInTheDocument()
    expect(screen.getByTestId("input-agente-id")).toBeInTheDocument()
    expect(screen.getByTestId("input-titulo")).toBeInTheDocument()
    expect(screen.getByTestId("input-descricao")).toBeInTheDocument()
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("exibe botão enviar desabilitado enquanto falta campo obrigatório", async () => {
    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await preencherCampos(user, { projetoId: "640", agenteId: "1" })
    expect(screen.getByTestId("btn-enviar")).toBeDisabled() // título ainda vazio

    await preencherCampos(user, { titulo: "Tarefa de teste" })
    expect(screen.getByTestId("btn-enviar")).toBeEnabled() // todos obrigatórios preenchidos
  })

  it("envia POST para /api/tarefas ao criar e exibe sucesso", async () => {
    mockOk({ id: 42, status: "draft" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await preencherCampos(user, {
      projetoId: "640",
      agenteId: "1",
      titulo: "Minha tarefa",
      descricao: "Descricao testando aqui",
    })
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/tarefas",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
          body: expect.any(String),
        })
      )

      const corpo = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(corpo.projetoId).toBe(640)
      expect(corpo.agenteId).toBe(1)
      expect(corpo.titulo).toBe("Minha tarefa")
      expect(corpo.descricao).toBe("Descricao testando aqui")
      expect(corpo.status).toBe("draft")
    })

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })
  })

  it("exibe erro quando o endpoint interno retorna 404", async () => {
    mockError(404, { message: "Endpoint não encontrado" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await preencherCampos(user, { projetoId: "640", agenteId: "1", titulo: "Tarefa de teste" })
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })
    expect(screen.getByTestId("api-error")).toHaveTextContent("Endpoint não encontrado")
  })

  it("exibe erro genérico para outros códigos HTTP", async () => {
    mockError(500, { message: "Erro interno" })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await preencherCampos(user, { projetoId: "640", agenteId: "1", titulo: "Tarefa de erro" })
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toBeInTheDocument()
    })
    expect(screen.getByTestId("api-error")).toHaveTextContent("Erro interno")
  })

  it("mantém botão desabilitado quando um campo obrigatório está vazio", async () => {
    mockOk({})

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    // Projeto e título preenchidos, agente vazio → botão desabilitado
    await preencherCampos(user, { projetoId: "640", titulo: "Alguma tarefa" })
    expect(screen.getByTestId("btn-enviar")).toBeDisabled()
  })

  it("limpa o formulário após sucesso", async () => {
    mockOk({ id: 99 })

    render(
      <BibliotecaThemeProvider>
        <NovaTarefaScreen />
      </BibliotecaThemeProvider>,
    )

    await preencherCampos(user, { projetoId: "640", agenteId: "1", titulo: "Tarefa para limpar" })
    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      expect(screen.getByTestId("success-alert")).toBeInTheDocument()
    })

    // Estado limpo → campos vazios → botão desabilitado de novo
    expect(screen.getByTestId("input-titulo").querySelector("input")).toHaveValue("")
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

    await preencherCampos(user, { projetoId: "640", agenteId: "1", titulo: "Tarefa longa" })

    // Botão habilitado antes de clicar (nenhum erro de validação)
    expect(screen.getByTestId("btn-enviar")).not.toBeDisabled()

    await user.click(screen.getByTestId("btn-enviar"))

    await waitFor(() => {
      const btn = screen.getByTestId("btn-enviar")
      expect(btn).toBeDisabled()
      expect(btn).toHaveTextContent(/Criando/)
    })
  })
})
