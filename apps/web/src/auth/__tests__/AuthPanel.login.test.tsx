// @vitest-environment jsdom
/**
 * Testes de integração do fluxo de login (AuthContext + LoginScreen).
 * Ele verifica: login bem-sucedido grava o refresh e autentica; login com
 * credenciais inválidas exibe erro no painel. O `fetch` é feito em stub.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import { AuthProvider, useAuth } from "../AuthContext"
import LoginScreen from "../../screens/LoginScreen"

interface StubCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string }
}

interface RouteHandler {
  predicate?: (call: StubCall) => boolean
  respond: () => { status: number; body: unknown }
  once?: boolean
  calls?: number
}

/** Harness: expõe estado da sessão para assert no teste. */
let sessionState: {
  status: string
  projetoSlug: string | null
} = { status: "unknown", projetoSlug: null }

function HarnessChild(): ReactNode {
  const { status, projeto } = useAuth()
  sessionState = { status, projetoSlug: projeto?.slug ?? null }
  return null
}

function renderLogin(routes: RouteHandler[]): void {
  sessionState = { status: "unknown", projetoSlug: null }

  const fetchStub = vi.fn(async (url: string, init: unknown) => {
    const call: StubCall = {
      url,
      init: init as StubCall["init"],
    }
    const rota = routes.find(
      (r) =>
        (!r.predicate || r.predicate(call)) &&
        (!r.once || !r.calls),
    )
    if (!rota) {
      return { status: 500, json: () => Promise.resolve({ ok: false }) }
    }
    rota.calls = (rota.calls ?? 0) + 1
    return {
      status: rota.respond().status,
      json: () => Promise.resolve(rota.respond().body),
    }
  })

  vi.stubGlobal("fetch", fetchStub)
  window.history.pushState({}, "", "/login")

  const ui = (
    <AuthProvider>
      <HarnessChild />
      <LoginScreen />
    </AuthProvider>
  )
  render(ui)
}

const usuario = {
  id: 1,
  nome: "Alexandre",
  username: "alexandre",
  email: "alexandre@globaltecnologia.net",
  telefone: null,
  cpf: null,
}

const loginOk = (projetosCount = 1): RouteHandler => ({
  predicate: (c) => c.url.endsWith("/api/auth/login"),
  respond: () => ({
    status: 200,
    body: {
      refreshToken: "refresh-ok",
      usuario,
      projetos: Array.from({ length: projetosCount }, (_, i) => ({
        id: i + 1,
        nome: `Projeto ${i + 1}`,
        slug: i === 0 ? "biblioteca-global" : `projeto-${i + 1}`,
        perfil: "admin",
      })),
    },
  }),
})

describe("AuthPanel login flow", () => {
  it("login com 1 projeto autentica e seleciona o projeto automaticamente", async () => {
    const user = userEvent.setup()
    const routes: RouteHandler[] = [
      loginOk(1),
      {
        predicate: (c) => c.url.endsWith("/api/auth/select-project"),
        respond: () => ({
          status: 200,
          body: {
            accessToken:
              "eyJhbGciOiJIUzI1NiJ9." +
              btoa(
                JSON.stringify({
                  sub: 1,
                  projetoId: 1,
                  perfil: "admin",
                  exp: 1_900_000,
                }),
              ) +
              ".sig",
            projeto: {
              id: 1,
              nome: "Projeto 1",
              slug: "biblioteca-global",
              perfil: "admin",
            },
          },
        }),
      },
    ]
    renderLogin(routes)

    await user.type(
      screen.getByLabelText(/E-mail\b/),
      "alexandre@globaltecnologia.net",
    )
    await user.type(screen.getByLabelText(/Senha\b/), "senha-secreta")
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    await waitFor(() => {
      expect(sessionState.status).toBe("authenticated")
      expect(sessionState.projetoSlug).toBe("biblioteca-global")
    })
  })

  it("login com credenciais inválidas mostra erro claro no painel", async () => {
    const user = userEvent.setup()
    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/login"),
        respond: () => ({
          status: 401,
          body: { code: "INVALID_CREDENTIALS", message: "Credenciais inválidas" },
        }),
      },
    ]
    renderLogin(routes)

    await user.type(
      screen.getByLabelText(/E-mail\b/),
      "errado@globaltecnologia.net",
    )
    await user.type(screen.getByLabelText(/Senha\b/), "senha-errada")
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    await waitFor(() => {
      expect(screen.getByTestId("login-error")).toBeInTheDocument()
      expect(screen.getByTestId("login-error")).toHaveTextContent(
        /incorretos/i,
      )
    })
    expect(sessionState.status).toBe("unknown")
  })
})
