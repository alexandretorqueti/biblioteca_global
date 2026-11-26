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
  respond: (call?: StubCall) => { status: number; body: unknown }
  once?: boolean
  calls?: number
}

/** Harness: expõe estado da sessão para assert no teste. */
let sessionState: {
  status: string
  usuarioNome: string | null
  projetoSlug: string | null
} = { status: "unknown", usuarioNome: null, projetoSlug: null }

function HarnessChild(): ReactNode {
  const { status, usuario, projeto } = useAuth()
  sessionState = {
    status,
    usuarioNome: usuario?.nome ?? null,
    projetoSlug: projeto?.slug ?? null,
  }
  return null
}

function renderLogin(routes: RouteHandler[]): void {
  sessionState = { status: "unknown", usuarioNome: null, projetoSlug: null }

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
      status: rota.respond(call).status,
      json: () => Promise.resolve(rota.respond(call).body),
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
    await user.click(screen.getByLabelText(/Li e concordo com a Política de Privacidade/))
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    await waitFor(() => {
      expect(sessionState.status).toBe("authenticated")
      expect(sessionState.usuarioNome).toBe("Alexandre")
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
    await user.click(screen.getByLabelText(/Li e concordo com a Política de Privacidade/))
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    await waitFor(() => {
      expect(screen.getByTestId("login-error")).toBeInTheDocument()
      expect(screen.getByTestId("login-error")).toHaveTextContent(
        /incorretos/i,
      )
    })
    // Sem sessão: hidratação encerra o estado "unknown" (corrigido — antes
    // ficava "unknown" para sempre, travando em "Restaurando sessão…").
    expect(sessionState.status).toBe("unauthenticated")
  })

  it("restaura automaticamente o único projeto após reload", async () => {
    localStorage.setItem("bg.refreshToken", "refresh-persistido")
    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/refresh"),
        respond: () => ({
          status: 200,
          body: {
            refreshToken: "refresh-renovado",
            projetos: [
              {
                id: 7,
                nome: "Projeto único",
                slug: "projeto-unico",
                perfil: "operador",
              },
            ],
          },
        }),
      },
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
                  projetoId: 7,
                  perfil: "operador",
                  exp: 1_900_000,
                }),
              ) +
              ".sig",
            projeto: {
              id: 7,
              nome: "Projeto único",
              slug: "projeto-unico",
              perfil: "operador",
            },
          },
        }),
      },
    ]

    renderLogin(routes)

    await waitFor(() => {
      expect(sessionState.status).toBe("authenticated")
      expect(sessionState.projetoSlug).toBe("projeto-unico")
    })
    localStorage.removeItem("bg.refreshToken")
  })

  it("fluxo código: POST /auth/verify-code carrega consentimentoAceito e erros chegam à UI", async () => {
    const user = userEvent.setup()
    let verifyBody: unknown = null
    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/request-code"),
        respond: () => ({ status: 200, body: { ok: true } }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/verify-code"),
        once: true,
        respond: (call) => {
          verifyBody = call ? JSON.parse((call.init as { body?: string }).body ?? "{}") : null
          return {
            status: 200,
            body: {
              primeiraVez: false,
              refreshToken: "refresh-ok",
              usuario,
              projetos: [
                {
                  id: 1,
                  nome: "Projeto 1",
                  slug: "biblioteca-global",
                  perfil: "admin",
                },
              ],
            },
          }
        },
      },
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
    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(
      screen.getByLabelText(/E-mail\b/),
      "gabriel@globaltecnologia.net",
    )
    await user.click(screen.getByRole("button", { name: "Enviar código" }))
    await waitFor(() => {
      expect(screen.getByTestId("code-input")).toBeInTheDocument()
    })
    await user.type(screen.getByTestId("code-input"), "123456")
    await user.click(screen.getByLabelText(/Li e concordo com a Política de Privacidade/))
    await user.click(screen.getByRole("button", { name: "Entrar" }))
    await waitFor(() => {
      expect(sessionState.status).toBe("authenticated")
    })
    // POST /auth/verify-code deve ter consentimentoAceito: true no corpo
    expect((verifyBody as { consentimentoAceito?: boolean })?.consentimentoAceito).toBe(true)
  })

  it("fluxo código: erro 400 de consentimento aparece como mensagem própria (não 'código inválido')", async () => {
    const user = userEvent.setup()
    const routes: RouteHandler[] = [
      {
        predicate: (c) => c.url.endsWith("/api/auth/request-code"),
        respond: () => ({ status: 200, body: { ok: true } }),
      },
      {
        predicate: (c) => c.url.endsWith("/api/auth/verify-code"),
        respond: () => ({
          status: 400,
          body: {
            code: "CONSENTIMENT_REQUERIDO",
            message: "É necessário aceitar a Política de Privacidade para entrar",
          },
        }),
      },
    ]
    renderLogin(routes)
    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(
      screen.getByLabelText(/E-mail\b/),
      "gabriel@globaltecnologia.net",
    )
    await user.click(screen.getByRole("button", { name: "Enviar código" }))
    await waitFor(() => {
      expect(screen.getByTestId("code-input")).toBeInTheDocument()
    })
    await user.type(screen.getByTestId("code-input"), "123456")
    await user.click(screen.getByLabelText(/Li e concordo com a Política de Privacidade/))
    await user.click(screen.getByRole("button", { name: "Entrar" }))
    await waitFor(() => {
      // A mensagem real da API deve aparecer — não "código inválido" nem sucesso
      expect(
        screen.queryByText(
          /É necessário aceitar a Política de Privacidade/i,
        ),
      ).toBeInTheDocument()
      // Não deve exibir "Código inválido" nem "Login realizado com sucesso"
      expect(screen.queryByText(/Código inválido/i)).not.toBeInTheDocument()
      expect(
        screen.queryByText(/Login realizado com sucesso/i),
      ).not.toBeInTheDocument()
    })
  })
})
