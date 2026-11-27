// @vitest-environment jsdom
/**
 * Testes da TarefaFluxoScreen (subtarefa 1624 — auditoria responsiva
 * 360/768/1440):
 * - Dialogs de delegar/devolver utilizáveis em 360px: abrir, preencher e
 *   confirmar sem corte — evidência estrutural + auditoria do CSS gerado
 *   (nenhum `min-width` fixo acima da área útil fora de media query);
 * - payload das transições (delegar: responsavelId; devolver: sabor+mensagem);
 * - cancelamento fecha o dialog sem disparar POST;
 * - página inteira sem conteúdo que estoure o viewport de 360px.
 */
import { expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import TarefaFluxoScreen from "../TarefaFluxoScreen"
import {
  LIMITE_CONTEUDO_DIALOG_XS,
  LIMITE_CONTEUDO_PAGINA_XS,
  esperarSemMinWidthForaDeMedia,
} from "./responsivo"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__fluxoBundleFalso ?? undefined,
}))

type Post = { path: string; body?: Record<string, unknown> }

declare global {
  var __fluxoBundleFalso: unknown
  var __fluxoPosts: Post[]
}

const TAREFA = {
  id: 77,
  titulo: "Tarefa com um título muito grande para caber em 360 pixels sem quebrar",
  status: "aberta",
  responsavelId: 31,
  organizacaoId: 5,
  prazo: "2026-11-30 18:00:00",
}

const HISTORICO = [
  {
    id: 1,
    tipoEvento: "criacao",
    deColaboradorNome: null,
    paraColaboradorNome: null,
    mensagem: "Tarefa criada",
    criadoEm: "2026-11-25T10:00:00Z",
  },
]

const MENSAGENS = [
  { id: 10, autorId: 31, autorNome: "Maria Silva", texto: "Ok, assumo.", criadoEm: "2026-11-25T11:00:00Z" },
]

const COLABORADORES = [
  { id: 30, nome: "Ana Souza" },
  { id: 31, nome: "Maria Silva" },
]

function montarBundle() {
  const http = {
    request: vi.fn((method: string, path: string, opts?: { body?: Record<string, unknown> }) => {
      if (method === "POST") {
        globalThis.__fluxoPosts.push({ path, body: opts?.body })
        return Promise.resolve({ ok: true })
      }
      if (path === "/gestao-de-tarefas-global/tarefas/77") return Promise.resolve(TAREFA)
      if (path.endsWith("/historico")) return Promise.resolve(HISTORICO)
      if (path.endsWith("/mensagens")) return Promise.resolve(MENSAGENS)
      if (path.endsWith("/anexos")) return Promise.resolve([])
      if (path.endsWith("/colaboradores")) return Promise.resolve(COLABORADORES)
      return Promise.resolve({})
    }),
  }
  return { http, getAccessToken: () => "token-falso" }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__fluxoPosts = []
  globalThis.__fluxoBundleFalso = montarBundle()
})

async function montarTela() {
  render(
    <BibliotecaThemeProvider>
      <TarefaFluxoScreen parentRow={{ id: 77 }} />
    </BibliotecaThemeProvider>,
  )
  // Tarefa carregada (título presente, loading sumido).
  await screen.findByText(/Tarefa com um título muito grande/)
}

it("dialog DELEGAR: abre, seleciona responsável e confirma com payload correto", async () => {
  const user = userEvent.setup()
  await montarTela()

  await user.click(screen.getByRole("button", { name: /Delegar/ }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).getByText("Delegar tarefa")).toBeInTheDocument()

  // 360px: nenhum min-width fixo acima da área útil do DialogContent.
  esperarSemMinWidthForaDeMedia(dialog, LIMITE_CONTEUDO_DIALOG_XS)

  // Botão de confirmação desabilitado sem responsável.
  const confirmar = within(dialog).getByRole("button", { name: "Delegar" })
  expect(confirmar).toBeDisabled()

  await user.click(within(dialog).getByRole("combobox"))
  const option = await screen.findByRole("option", { name: "Ana Souza" })
  await user.click(option)

  await waitFor(() => expect(confirmar).toBeEnabled())
  await user.click(confirmar)

  await waitFor(() =>
    expect(
      globalThis.__fluxoPosts.find((p) => p.path.endsWith("/tarefas/77/delegar")),
    ).toBeTruthy(),
  )
  const post = globalThis.__fluxoPosts.find((p) => p.path.endsWith("/delegar"))!
  expect(post.body).toEqual({ responsavelId: 30 })
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(await screen.findByText(/Tarefa delegada/)).toBeInTheDocument()
})

it("dialog DEVOLVER: exige mensagem, envia sabor + mensagem e cancela sem POST", async () => {
  const user = userEvent.setup()
  await montarTela()

  await user.click(screen.getByRole("button", { name: /^Devolver$/ }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).getByText("Devolver tarefa")).toBeInTheDocument()

  // 360px: sem min-width fixo acima da área útil.
  esperarSemMinWidthForaDeMedia(dialog, LIMITE_CONTEUDO_DIALOG_XS)

  // Confirmar bloqueado sem mensagem.
  const confirmar = within(dialog).getByRole("button", { name: "Devolver" })
  expect(confirmar).toBeDisabled()

  // Cancelar fecha sem POST.
  await user.click(within(dialog).getByRole("button", { name: "Cancelar" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(globalThis.__fluxoPosts).toHaveLength(0)

  // Reabrir, escolher sabor e preencher mensagem.
  await user.click(screen.getByRole("button", { name: /^Devolver$/ }))
  const dialog2 = await screen.findByRole("dialog")
  await user.click(within(dialog2).getByRole("radio", { name: /Concluída/ }))
  await user.type(
    within(dialog2).getByLabelText("Mensagem da devolução"),
    "Escopo finalizado, devolvendo ao delegador.",
  )
  await user.click(within(dialog2).getByRole("button", { name: "Devolver" }))

  await waitFor(() =>
    expect(
      globalThis.__fluxoPosts.find((p) => p.path.endsWith("/devolver")),
    ).toBeTruthy(),
  )
  const post = globalThis.__fluxoPosts.find((p) => p.path.endsWith("/devolver"))!
  expect(post.body).toEqual({
    sabor: "concluida",
    mensagem: "Escopo finalizado, devolvendo ao delegador.",
  })
})

it("página inteira: nenhum conteúdo com min-width fixo acima do viewport 360px", async () => {
  await montarTela()
  esperarSemMinWidthForaDeMedia(document.body, LIMITE_CONTEUDO_PAGINA_XS)
})
