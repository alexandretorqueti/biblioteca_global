// @vitest-environment jsdom
/**
 * SystemScreen — único projeto / lista vazia: botão NÃO deve aparecer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { ReactNode, ReactElement } from "react"

function MockGeradorSistema({ actions }: { actions?: ReactNode }): ReactElement {
  return <div data-testid="gerador-sistema">{actions}</div>
}
function MockHelpDeskWidget(): null { return null }
function ThemeProviderWrapper({ children }: { children: ReactNode }): ReactElement {
  return <div data-testid="theme-provider-wrapper">{children}</div>
}

vi.mock("@biblioteca-global/api-client", () => ({ createHelpDeskClient: () => null }))
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    logout: vi.fn(async () => undefined),
    projeto: { id: 1, nome: "Projeto Único", slug: "unico", perfil: "admin" },
    projetos: [{ id: 1, nome: "Projeto Único", slug: "unico", perfil: "admin" }],
    bundle: { http: { setSessionRecovery: vi.fn() } },
  }),
}))
vi.mock("../../project/ProjectContext", () => ({
  useProject: () => ({ config: { resources: [] as never[] }, runtime: {} }),
}))
vi.mock("@biblioteca-global/ui", () => ({ GeradorSistema: MockGeradorSistema, HelpDeskWidget: MockHelpDeskWidget }))
vi.mock("../../theme/ThemeContext", () => ({
  ThemeSettingProvider: ({ children }: { children: ReactNode }) => <ThemeProviderWrapper>{children}</ThemeProviderWrapper>,
  useThemeSetting: () => ({ toggle: vi.fn(), themeName: "claro" }),
}))

import SystemScreen from "../SystemScreen"

describe("SystemScreen — único projeto", () => {
  beforeEach(() => { window.history.pushState({}, "", "/app") })

  it("não exibe o botão de troca quando há apenas um projeto", () => {
    render(<SystemScreen />)
    expect(screen.queryByTestId("project-switch-button")).not.toBeInTheDocument()
  })
})
