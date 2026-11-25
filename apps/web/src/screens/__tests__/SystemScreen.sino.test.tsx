// @vitest-environment jsdom
/**
 * SystemScreen — sino de notificações (macro #5, subtarefa 5):
 * o sino só aparece montado no projeto `gestao-de-tarefas-global`;
 * os demais projetos permanecem visualmente inalterados.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"

const mockAuth = vi.hoisted(() => ({
  current: null as { id: number; nome: string; slug: string; perfil: string } | null,
}))

function MockGeradorSistema({ actions }: { actions?: ReactNode }): ReactNode {
  return <div data-testid="gerador-sistema">{actions}</div>
}
function MockHelpDeskWidget(): null {
  return null
}

vi.mock("@biblioteca-global/api-client", () => ({ createHelpDeskClient: () => null }))
// Sino stub: o teste verifica apenas o GATE por slug (renderização real do
// sino é coberta em project/__tests__/NotificacoesSino.test.tsx).
vi.mock("../../project/NotificacoesSino", () => ({
  NotificacoesSino: ({ slug }: { slug: string }) => (
    <div data-testid="sino-notificacoes">{slug}</div>
  ),
}))
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    logout: vi.fn(async () => undefined),
    projeto: mockAuth.current,
    projetos: [mockAuth.current].filter(Boolean),
    bundle: {
      http: { setSessionRecovery: vi.fn(), request: vi.fn(async () => ({ itens: [], naoLidas: 0 })) },
      getAccessToken: () => "token",
    },
  }),
}))
vi.mock("../../project/ProjectContext", () => ({
  useProject: () => ({ config: { resources: [] as never[] }, runtime: {} }),
}))
vi.mock("@biblioteca-global/ui", () => ({
  GeradorSistema: MockGeradorSistema,
  HelpDeskWidget: MockHelpDeskWidget,
}))
vi.mock("../../theme/ThemeContext", () => ({
  useThemeSetting: () => ({ toggle: vi.fn(), themeName: "claro" }),
}))

import SystemScreen from "../SystemScreen"

describe("SystemScreen — sino de notificações por projeto", () => {
  it("monta o sino no projeto gestao-de-tarefas-global", () => {
    mockAuth.current = { id: 13, nome: "Gestão", slug: "gestao-de-tarefas-global", perfil: "admin" }
    render(<SystemScreen />)
    expect(screen.getByTestId("sino-notificacoes")).toBeInTheDocument()
  })

  it("não monta o sino em outros projetos", () => {
    mockAuth.current = { id: 1, nome: "Outro", slug: "gerenteagentes", perfil: "admin" }
    render(<SystemScreen />)
    expect(screen.queryByTestId("sino-notificacoes")).not.toBeInTheDocument()
  })
})
