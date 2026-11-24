// @vitest-environment jsdom
/**
 * Testes de redimensionamento do painel de detalhe do Mapa de agentes
 * (tarefa 1118 — subtarefa 1593).
 *
 * Valida:
 * - Alça de redimensionamento presente no painel largo (cursor de resize)
 * - Arrastar a borda esquerda aumenta/diminui a largura dentro dos limites
 * - Largura persistida em localStorage é reaplicada na montagem
 * - Valores corrompidos fora do intervalo caem no default (480px)
 * - Drawer (telas estreitas) reutiliza a mesma largura persistida
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"
import { DETAIL_DEFAULT_WIDTH, DETAIL_MAX_WIDTH, DETAIL_MIN_WIDTH, readPersistedDetailWidth } from "../DetailPanelResize"

const STORAGE_KEY = "operation-map-detail-width"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
  },
}))

// Mock do useMediaQuery para controlar a resposta (tela larga/estreita)
let mockIsWideScreen = false
vi.mock("@mui/material", async () => {
  const actual = await vi.importActual("@mui/material")
  return {
    ...actual,
    useMediaQuery: () => mockIsWideScreen,
  }
})

function bundleFalso(tarefas: Array<{ id: number; titulo: string; status: string; projetoId: number; descricao: string | null; dependsOnTaskId: number | null; createdAt: string; updatedAt: string }>) {
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (_method: string, path: string) => {
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
        if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
        if (path.endsWith("/motor-detail")) return { motorId: "m1", exists: false, message: "Não enviada" }
        if (path.endsWith("/subtarefas")) return []
        if (path.endsWith("/chat")) return []
        return {}
      },
    },
  }
}

function tarefaFactory(id: number, titulo: string, status: string) {
  return {
    id,
    titulo,
    status,
    projetoId: 1,
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  }
}

function renderScreen() {
  return render(
    <BibliotecaThemeProvider>
      <OperationMapScreen />
    </BibliotecaThemeProvider>,
  )
}

/**
 * O MUI gera a largura em media query (@media min-width) dentro de <style> no
 * <head>; o jsdom não resolve media queries no computed style, então a largura
 * efetiva é verificada no CSS emitido.
 */
function cssNoHead(): string {
  return Array.from(document.head.querySelectorAll("style"))
    .map(style => style.textContent ?? "")
    .join("\n")
}

/** Arrasta a alça: pointerDown na alça, pointermove na janela, pointerUp. */
function arrastarAlca(clientXInicial: number, clientXFim: number) {
  const alca = screen.getByTestId("detail-resize-handle")
  fireEvent.pointerDown(alca, { clientX: clientXInicial, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: clientXFim, pointerId: 1 })
  fireEvent.pointerUp(window, { clientX: clientXFim, pointerId: 1 })
}

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.__bundleMapa
  mockIsWideScreen = false
  window.localStorage.removeItem(STORAGE_KEY)
})

describe("OperationMapScreen — redimensionamento do detalhe (tarefa 1118)", () => {
  it("mostra a alça de redimensionamento no painel largo com cursor de resize", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    const alca = await screen.findByTestId("detail-resize-handle")
    expect(alca).toBeInTheDocument()
    expect(alca).toHaveAttribute("role", "separator")
    expect(alca).toHaveAttribute("aria-label", "Redimensionar detalhe da tarefa")
    expect(alca).toHaveStyle({ cursor: "col-resize" })
    // Primeira visita: largura default de 480px (media query lg emitida no CSS)
    expect(cssNoHead()).toContain("width:480px")
  })

  it("arrastar a borda para a esquerda aumenta a largura e persiste em localStorage", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    await screen.findByTestId("detail-resize-handle")
    // Arrasta 100px para a esquerda (clientX diminui) → 480 + 100 = 580px
    arrastarAlca(100, 0)

    await waitFor(() => expect(cssNoHead()).toContain("width:580px"))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("580")
  })

  it("arrastar para a direita diminui a largura até o limite mínimo", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    await screen.findByTestId("detail-resize-handle")
    // Arrasta 400px para a direita: 480 - 400 = 80 → limita no mínimo (360)
    arrastarAlca(0, 400)

    await waitFor(() => expect(cssNoHead()).toContain(`width:${DETAIL_MIN_WIDTH}px`))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DETAIL_MIN_WIDTH))
  })

  it("reaplica a largura persistida em localStorage na montagem", async () => {
    mockIsWideScreen = true
    window.localStorage.setItem(STORAGE_KEY, "620")
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    await screen.findByTestId("detail-resize-handle")
    expect(cssNoHead()).toContain("width:620px")
  })

  it("descarta valor persistido corrompido/fora do intervalo e usa o default", async () => {
    mockIsWideScreen = true
    window.localStorage.setItem(STORAGE_KEY, "not-a-number")
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    await screen.findByTestId("detail-resize-handle")
    expect(cssNoHead()).toContain(`width:${DETAIL_DEFAULT_WIDTH}px`)
    expect(readPersistedDetailWidth(DETAIL_DEFAULT_WIDTH)).toBe(DETAIL_DEFAULT_WIDTH)
  })

  it("aplica o mesmo limite mínimo na leitura do valor persistido", () => {
    window.localStorage.setItem(STORAGE_KEY, "100")
    expect(readPersistedDetailWidth()).toBe(DETAIL_MIN_WIDTH)
    window.localStorage.setItem(STORAGE_KEY, "9999")
    expect(readPersistedDetailWidth()).toBe(DETAIL_MAX_WIDTH)
  })

  it("drawer em telas estreitas reutiliza a largura persistida", async () => {
    mockIsWideScreen = false
    window.localStorage.setItem(STORAGE_KEY, "560")
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa do mapa", "paused")])
    renderScreen()

    await screen.findByTestId("operation-map-task-1")
    fireEvent.click(screen.getByTestId("operation-map-task-1"))
    await screen.findByTestId("operation-task-drawer")
    // Largura persistida (560px) emitida na media query sm do Drawer, com teto de 680
    expect(cssNoHead()).toContain("width:560px")
  })
})
