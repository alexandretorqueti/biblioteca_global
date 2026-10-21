// @vitest-environment jsdom
/**
 * Título dinâmico da aba (task-p1-1028): ProjectProvider define
 * document.title = config.app.name do projeto selecionado, com fallback
 * "Biblioteca Global" quando não há projeto/config (login, seleção).
 * Trocar de projeto atualiza o título sem recarregar a página.
 *
 * Nota: os testes existentes de SystemScreen mockam ProjectContext por
 * completo, então montamos aqui o ProjectProvider real (registry e auth
 * simulados) para exercitar o useEffect de título de ponta a ponta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"

const mockAuth = vi.hoisted(() => ({
  current: null as { id: number; nome: string; slug: string; perfil: string } | null,
}))

const mockConfigs = vi.hoisted<Record<string, unknown>>(() => ({
  taqui: { app: { name: "TaQui", logo: "package" }, groups: [] },
  gerenteagentes: { app: { name: "Gerente Agentes", logo: "smart_toy" }, groups: [] },
}))

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    logout: vi.fn(async () => undefined),
    projeto: mockAuth.current,
    projetos: [],
    bundle: { http: { setSessionRecovery: vi.fn(), request: vi.fn(async () => ({})) } },
  }),
}))

vi.mock("../../project/registry/projects", () => ({
  getProjectConfig: (slug: string) => mockConfigs[slug],
}))

vi.mock("@biblioteca-global/api-client", () => ({
  createDataSource: () => ({}),
  resolverPrefixoResource: (slug: string, resource: string) => `/${slug}/${resource}`,
}))

import { ProjectProvider } from "../../project/ProjectContext"

function Wrapper({ children }: { children: ReactNode }) {
  return <ProjectProvider>{children}</ProjectProvider>
}

describe("Título da aba por projeto (document.title)", () => {
  beforeEach(() => {
    document.title = ""
    mockAuth.current = null
  })

  it("mantém o fallback da plataforma sem projeto selecionado", () => {
    render(<div data-testid="conteudo">Login/Seleção</div>, { wrapper: Wrapper })
    expect(document.title).toBe("Biblioteca Global")
  })

  it("usa config.app.name do projeto selecionado", () => {
    mockAuth.current = { id: 3, nome: "TaQui", slug: "taqui", perfil: "admin" }
    render(<div data-testid="conteudo">Sistema</div>, { wrapper: Wrapper })
    expect(screen.getByTestId("conteudo")).toBeInTheDocument()
    expect(document.title).toBe("TaQui")
  })

  it("atualiza o título ao trocar de projeto, sem recarregar a página", async () => {
    mockAuth.current = { id: 3, nome: "TaQui", slug: "taqui", perfil: "admin" }
    const { rerender } = render(<div data-testid="conteudo">Sistema</div>, { wrapper: Wrapper })
    expect(document.title).toBe("TaQui")

    mockAuth.current = { id: 1, nome: "Gerente Agentes", slug: "gerenteagentes", perfil: "admin" }
    rerender(<div data-testid="conteudo">Sistema</div>)
    expect(document.title).toBe("Gerente Agentes")

    mockAuth.current = null
    rerender(<div data-testid="conteudo">Sistema</div>)
    expect(document.title).toBe("Biblioteca Global")
  })
})
