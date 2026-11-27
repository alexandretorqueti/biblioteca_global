// @vitest-environment jsdom
/**
 * Testes da VisoesTarefasScreen (macro #8, subtarefa 2):
 * - modo agrupamentos (sem props): seções Por área / Por tag com contagens
 *   vindas de GET /:slug/visoes/resumo (front não recalcula);
 * - clique no grupo abre o drill interno (GET /:slug/visoes/tarefas com
 *   areaId OU tagId + filtros rápidos como query);
 * - filtros rápidos alteram a query enviada ao servidor (status multi,
 *   bucket de prazo, responsável — "eu" resolve via `sub` do token);
 * - modo childRoute (filterField/filterValue) abre o drill direto;
 * - estados carregando/erro/vazio com feedback visual.
 */
import { expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import VisoesTarefasScreen from "../VisoesTarefasScreen"

// Mock do useApi (bundle fake) — a tela não fala HTTP direto.
vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

type Consulta = {
  method: string
  path: string
  query?: Record<string, string | number | boolean | undefined>
}

const RESUMO = {
  areas: [
    { id: 11, nome: "Financeiro", total: 4, pendentes: 2, vencidas: 1 },
    { id: 12, nome: "RH", total: 0, pendentes: 0, vencidas: 0 },
  ],
  tags: [{ id: 21, nome: "urgente", total: 3, pendentes: 3, vencidas: 2 }],
}

const TAREFAS = {
  items: [
    {
      id: 101,
      titulo: "Pagar fornecedor",
      descricao: "Fatura 1234",
      prioridade: "urgente",
      prazo: "2026-11-26 08:00:00",
      status: "aberta",
      areaId: 11,
      areaNome: "Financeiro",
      responsavelId: 31,
      responsavelNome: "Maria Silva",
    },
    {
      id: 102,
      titulo: "Sem prazo",
      descricao: null,
      prioridade: "baixa",
      prazo: null,
      status: "delegada",
      areaId: 11,
      areaNome: "Financeiro",
      responsavelId: null,
      responsavelNome: null,
    },
  ],
  total: 2,
}

const COLABORADORES = [
  { id: 30, nome: "Ana Souza" },
  { id: 31, nome: "Maria Silva" },
]

declare global {
  var __bundleFalso: unknown
  var __visoesConsultas: Consulta[]
  var __visoesFalhar: boolean
}

function montarBundle() {
  const http = {
    request: vi.fn((method: string, path: string, opts?: { query?: Consulta["query"] }) => {
      const consulta: Consulta = { method, path, query: opts?.query }
      globalThis.__visoesConsultas.push(consulta)
      if (globalThis.__visoesFalhar) {
        return Promise.reject(new Error("Falha simulada do servidor"))
      }
      if (path.endsWith("/visoes/resumo")) return Promise.resolve(RESUMO)
      if (path.endsWith("/visoes/tarefas")) return Promise.resolve(TAREFAS)
      if (path.endsWith("/colaboradores")) return Promise.resolve(COLABORADORES)
      return Promise.resolve({})
    }),
  }
  // Token fake com sub=31 (Maria Silva) — JWT "header.payload.sig".
  const payload = btoa(JSON.stringify({ sub: 31, exp: 9999999999 }))
  return {
    http,
    getAccessToken: () => `h.${payload}.s`,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__visoesConsultas = []
  globalThis.__visoesFalhar = false
  globalThis.__bundleFalso = montarBundle()
})

function consultasTarefas(): Consulta[] {
  return globalThis.__visoesConsultas.filter((c) => c.path.endsWith("/visoes/tarefas"))
}

it("modo agrupamentos: seções com contagens do servidor e drill por área", async () => {
  const user = userEvent.setup()
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen />
    </BibliotecaThemeProvider>,
  )

  // Seções e contagens vindas do RESUMO (não calculadas no front).
  const secaoAreas = await screen.findByTestId("visoes-secao-areas")
  expect(screen.getByTestId("visoes-secao-tags")).toBeInTheDocument()
  const area = within(secaoAreas).getByTestId("visoes-grupo-areaId-11")
  expect(area).toHaveTextContent("Financeiro")
  expect(area).toHaveTextContent("Pendentes: 2")
  expect(area).toHaveTextContent("Vencidas: 1")
  expect(area).toHaveTextContent("Total: 4")
  // Área sem tarefas → zeros do resumo.
  expect(within(secaoAreas).getByTestId("visoes-grupo-areaId-12")).toHaveTextContent("Total: 0")
  expect(screen.getByTestId("visoes-grupo-tagId-21")).toHaveTextContent("Vencidas: 2")

  // Clique no grupo abre o DRILL interno consultando a API com areaId.
  await user.click(area)
  expect(await screen.findByTestId("visoes-tarefa-101")).toBeInTheDocument()
  expect(screen.getByTestId("visoes-tarefa-101")).toHaveTextContent("Pagar fornecedor")

  await waitFor(() => expect(consultasTarefas().length).toBeGreaterThan(0))
  const consulta = consultasTarefas()[0]!
  expect(consulta.query?.areaId).toBe(11)
  expect(consulta.query?.tagId).toBeUndefined()
  // Status padrão = pendentes → multi no enum da API.
  expect(String(consulta.query?.status)).toBe("aberta,delegada,precisa_informacoes,aguardando_terceiro")
})

it("drill por tag via clique na seção Por tag", async () => {
  const user = userEvent.setup()
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen />
    </BibliotecaThemeProvider>,
  )

  const tag = await screen.findByTestId("visoes-grupo-tagId-21")
  await user.click(tag)
  expect(await screen.findByTestId("visoes-tarefa-101")).toBeInTheDocument()

  await waitFor(() => expect(consultasTarefas().length).toBeGreaterThan(0))
  const consulta = consultasTarefas()[0]!
  expect(consulta.query?.tagId).toBe(21)
  expect(consulta.query?.areaId).toBeUndefined()
})

it("modo childRoute (área): abre o drill direto com filterField/filterValue", async () => {
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="areaId" filterValue={12} />
    </BibliotecaThemeProvider>,
  )

  expect(await screen.findByTestId("visoes-tarefa-101")).toBeInTheDocument()

  await waitFor(() => expect(consultasTarefas().length).toBeGreaterThan(0))
  const consulta = consultasTarefas()[0]!
  expect(consulta.query?.areaId).toBe(12)
  expect(consulta.query?.tagId).toBeUndefined()
  // Botão de voltar para a tela de agrupamentos.
  expect(screen.getByTestId("visoes-voltar")).toBeInTheDocument()
})

it("modo childRoute (tag): abre o drill direto com filterField tagId", async () => {
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="tagId" filterValue="21" />
    </BibliotecaThemeProvider>,
  )

  expect(await screen.findByTestId("visoes-tarefa-101")).toBeInTheDocument()

  await waitFor(() => expect(consultasTarefas().length).toBeGreaterThan(0))
  expect(consultasTarefas()[0]!.query?.tagId).toBe(21)
})

it("filtro rápido de status altera a query (multi CSV)", async () => {
  const user = userEvent.setup()
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="areaId" filterValue={11} />
    </BibliotecaThemeProvider>,
  )
  await screen.findByTestId("visoes-tarefa-101")

  await user.click(screen.getByTestId("visoes-chip-status-concluida"))
  await waitFor(() => expect(consultasTarefas().length).toBeGreaterThanOrEqual(2))
  expect(String(consultasTarefas().at(-1)?.query?.status)).toBe("concluida")
})

it("filtros rápidos de prazo e responsável alteram a query", async () => {
  const user = userEvent.setup()
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="areaId" filterValue={11} />
    </BibliotecaThemeProvider>,
  )
  await screen.findByTestId("visoes-tarefa-101")

  await user.click(screen.getByTestId("visoes-chip-prazo-vencida"))
  await waitFor(() => expect(consultasTarefas().at(-1)?.query?.prazo).toBe("vencida"))

  // MUI Select nativo: role=combobox; opção pelo texto.
  const combobox = document.querySelector<HTMLSpanElement>(
    '[data-testid="visoes-responsavel"] [role="combobox"]',
  )
  expect(combobox).not.toBeNull()
  await user.click(combobox!)
  await user.click(await screen.findByRole("option", { name: "Ana Souza" }))
  await waitFor(() => expect(consultasTarefas().at(-1)?.query?.responsavelId).toBe(30))
})

it("seletor de responsável inclui 'Eu' (sub do token = 31)", async () => {
  const user = userEvent.setup()
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="areaId" filterValue={11} />
    </BibliotecaThemeProvider>,
  )
  await screen.findByTestId("visoes-tarefa-101")

  const combobox = document.querySelector<HTMLSpanElement>(
    '[data-testid="visoes-responsavel"] [role="combobox"]',
  )
  expect(combobox).not.toBeNull()
  await user.click(combobox!)
  const opcaoEu = await screen.findByTestId("visoes-responsavel-eu")
  expect(opcaoEu).toBeInTheDocument()
  await user.click(opcaoEu)
  await waitFor(() => expect(consultasTarefas().at(-1)?.query?.responsavelId).toBe(31))
})

it("erro da API: feedback visual + tentar novamente", async () => {
  globalThis.__visoesFalhar = true
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen />
    </BibliotecaThemeProvider>,
  )

  const erro = await screen.findByTestId("visoes-erro")
  expect(erro).toHaveTextContent("Falha simulada do servidor")
  expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument()
})

it("lista vazia: estado vazio sem erro", async () => {
  // bundle que devolve itens vazios para /visoes/tarefas.
  globalThis.__bundleFalso = {
    http: {
      request: vi.fn((method: string, path: string) => {
        if (path.endsWith("/visoes/resumo")) return Promise.resolve(RESUMO)
        if (path.endsWith("/visoes/tarefas")) return Promise.resolve({ items: [], total: 0 })
        if (path.endsWith("/colaboradores")) return Promise.resolve(COLABORADORES)
        return Promise.resolve({})
      }),
    },
    getAccessToken: () => null,
  }
  render(
    <BibliotecaThemeProvider>
      <VisoesTarefasScreen filterField="areaId" filterValue={11} />
    </BibliotecaThemeProvider>,
  )

  expect(await screen.findByTestId("visoes-vazio")).toBeInTheDocument()
})
