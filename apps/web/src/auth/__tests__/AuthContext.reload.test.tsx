// @vitest-environment jsdom
/**
 * Testes de integração — fluxo de reload (F5) e logout.
 *
 * Cobrem os cenários da subtarefa 3 (validação integrada):
 *   1. Reload com refresh + projetoId persistido → renew seleciona o projeto
 *      correto automaticamente (projeto não-null após hidratação).
 *   2. Reload com projetoId persistido de projeto removido da lista →
 *      cai na tela de seleção (>1 projetos) ou auto-seleção (1 projeto).
 *   3. Logout limpa o projetoId do localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import { AuthProvider, useAuth } from "../AuthContext"

// ─── Helpers ────────────────────────────────────────────────────────────────

interface StubCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string }
}

interface RouteHandler {
  predicate?: (call: StubCall) => boolean
  respond: () => { status: number; body: unknown }
}

/** Estado capturado do AuthContext para asserções. */
interface SessionSnapshot {
  status: string
  projetoId: number | null
  projetoSlug: string | null
  projetosCount: number
}

let snapshot: SessionSnapshot = {
  status: "unknown",
  projetoId: null,
  projetoSlug: null,
  projetosCount: 0,
}

/** Componente que captura o estado do AuthContext a cada render. */
function SnapshotChild(): ReactNode {
  const { status, projeto, projetos } = useAuth()
  snapshot = {
    status,
    projetoId: projeto?.id ?? null,
    projetoSlug: projeto?.slug ?? null,
    projetosCount: projetos.length,
  }
  return null
}

/** Monta o AuthProvider com stub de fetch e rotas pré-definidas. */
function renderWithRoutes(routes: RouteHandler[]): void {
  snapshot = {
    status: "unknown",
    projetoId: null,
    projetoSlug: null,
    projetosCount: 0,
  }

  const fetchStub = vi.fn(async (url: string, init: unknown) => {
    const call: StubCall = {
      url,
      init: init as StubCall["init"],
    }
    const rota = routes.find((r) => !r.predicate || r.predicate(call))
    if (!rota) {
      return { status: 500, json: () => Promise.resolve({ ok: false }) }
    }
    return {
      status: rota.respond().status,
      json: () => Promise.resolve(rota.respond().body),
    }
  })

  vi.stubGlobal("fetch", fetchStub)
  render(
    <AuthProvider>
      <SnapshotChild />
    </AuthProvider>,
  )
}

/** Access token JWT sintético com exp no futuro. */
function accessTokenFake(projetoId: number): string {
  return [
    "eyJhbGciOiJIUzI1NiJ9",
    btoa(JSON.stringify({ sub: 1, projetoId, perfil: "admin", exp: 1_900_000 })),
    "sig",
  ].join(".")
}

/** Resposta de refresh com N projetos. */
function refreshBody(projetos: Array<{ id: number; nome: string; slug: string; perfil: string }>): {
  refreshToken: string
  projetos: typeof projetos
} {
  return { refreshToken: "refresh-renovado", projetos }
}

/** Resposta de select-project. */
function selectProjectBody(projeto: { id: number; nome: string; slug: string; perfil: string }): {
  accessToken: string
  projeto: typeof projeto
} {
  return { accessToken: accessTokenFake(projeto.id), projeto }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const projetoA = { id: 10, nome: "TaQui", slug: "taqui", perfil: "admin" }
const projetoB = { id: 20, nome: "HelpDesk", slug: "helpdesk", perfil: "admin" }
const projetoC = { id: 30, nome: "Portaria", slug: "portaria", perfil: "operador" }

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ─── Cenário 1: reload com refresh + projetoId persistido ───────────────────

describe("Reload — projeto persistido", () => {
  it("seleciona automaticamente o projeto correto após F5 (projeto não-null)", async () => {
    // Pré-condição: sessão com refresh persistido e projetoId = 20 (HelpDesk).
    localStorage.setItem("bg.refreshToken", "refresh-original")
    localStorage.setItem("bg.projetoId", "20")

    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: refreshBody([projetoA, projetoB, projetoC]),
        }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/select-project"),
        respond: () => ({
          status: 200,
          body: selectProjectBody(projetoB),
        }),
      },
    ]

    renderWithRoutes(routes)

    await waitFor(() => {
      expect(snapshot.status).toBe("authenticated")
      expect(snapshot.projetoId).toBe(20)
      expect(snapshot.projetoSlug).toBe("helpdesk")
    })
  })

  it("seleciona o projeto mesmo quando há apenas 1 projeto na lista (auto-seleção)", async () => {
    localStorage.setItem("bg.refreshToken", "refresh-original")
    localStorage.setItem("bg.projetoId", "10")

    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: refreshBody([projetoA]),
        }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/select-project"),
        respond: () => ({
          status: 200,
          body: selectProjectBody(projetoA),
        }),
      },
    ]

    renderWithRoutes(routes)

    await waitFor(() => {
      expect(snapshot.status).toBe("authenticated")
      expect(snapshot.projetoId).toBe(10)
      expect(snapshot.projetoSlug).toBe("taqui")
    })
  })
})

// ─── Cenário 2: projetoId persistido de projeto removido ────────────────────

describe("Reload — projeto removido da lista", () => {
  it("com >1 projetos restantes: não seleciona (vai para tela de seleção)", async () => {
    // O projetoId 99 não existe mais na lista retornada pelo refresh.
    localStorage.setItem("bg.refreshToken", "refresh-original")
    localStorage.setItem("bg.projetoId", "99")

    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: refreshBody([projetoA, projetoB]),
        }),
      },
    ]

    renderWithRoutes(routes)

    // Após hidratação: autenticado, mas projeto = null (tela de seleção).
    await waitFor(() => {
      expect(snapshot.status).toBe("authenticated")
      expect(snapshot.projetoId).toBeNull()
      expect(snapshot.projetosCount).toBe(2)
    })
  })

  it("com apenas 1 projeto restante: auto-seleciona o único projeto", async () => {
    // O projetoId 99 não existe mais, mas há só 1 projeto → auto-seleção.
    localStorage.setItem("bg.refreshToken", "refresh-original")
    localStorage.setItem("bg.projetoId", "99")

    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: refreshBody([projetoC]),
        }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/select-project"),
        respond: () => ({
          status: 200,
          body: selectProjectBody(projetoC),
        }),
      },
    ]

    renderWithRoutes(routes)

    await waitFor(() => {
      expect(snapshot.status).toBe("authenticated")
      expect(snapshot.projetoId).toBe(30)
      expect(snapshot.projetoSlug).toBe("portaria")
    })
  })
})

// ─── Cenário 3: logout limpa projetoId ──────────────────────────────────────

describe("Logout — limpeza de projetoId", () => {
  it("logout remove bg.projetoId do localStorage", async () => {
    // Sessão autenticada com projeto selecionado.
    localStorage.setItem("bg.refreshToken", "refresh-original")
    localStorage.setItem("bg.projetoId", "10")

    let logoutFn: (() => Promise<void>) | null = null

    /** Componente que captura o estado E a função logout. */
    function CaptureAll(): ReactNode {
      const { logout, status, projeto, projetos } = useAuth()
      logoutFn = logout
      snapshot = {
        status,
        projetoId: projeto?.id ?? null,
        projetoSlug: projeto?.slug ?? null,
        projetosCount: projetos.length,
      }
      return null
    }

    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: refreshBody([projetoA]),
        }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/select-project"),
        respond: () => ({
          status: 200,
          body: selectProjectBody(projetoA),
        }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/logout"),
        respond: () => ({
          status: 200,
          body: { ok: true },
        }),
      },
    ]

    const fetchStub = vi.fn(async (url: string, init: unknown) => {
      const call: StubCall = {
        url,
        init: init as StubCall["init"],
      }
      const rota = routes.find((r) => !r.predicate || r.predicate(call))
      if (!rota) {
        return { status: 500, json: () => Promise.resolve({ ok: false }) }
      }
      return {
        status: rota.respond().status,
        json: () => Promise.resolve(rota.respond().body),
      }
    })

    vi.stubGlobal("fetch", fetchStub)

    // Reseta o snapshot antes de renderizar.
    snapshot = {
      status: "unknown",
      projetoId: null,
      projetoSlug: null,
      projetosCount: 0,
    }

    render(
      <AuthProvider>
        <CaptureAll />
      </AuthProvider>,
    )

    // Aguarda a hidratação completar.
    await waitFor(() => {
      expect(snapshot.status).toBe("authenticated")
      expect(snapshot.projetoId).toBe(10)
    })

    // Confirma que o projetoId está no localStorage antes do logout.
    expect(localStorage.getItem("bg.projetoId")).toBe("10")

    // Executa o logout.
    expect(logoutFn).not.toBeNull()
    await logoutFn!()

    // Verifica que o projetoId foi removido (síncrono — store.clear).
    expect(localStorage.getItem("bg.projetoId")).toBeNull()
    expect(localStorage.getItem("bg.refreshToken")).toBeNull()

    // Aguarda a atualização do estado React após o logout.
    await waitFor(() => {
      expect(snapshot.status).toBe("unauthenticated")
      expect(snapshot.projetoId).toBeNull()
    })
  })
})
