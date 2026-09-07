// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { createElement } from "react"
import { BibliotecaThemeProvider, clearCustomScreens, getCustomScreen } from "@biblioteca-global/ui"
import { registrarTelasCustom } from "../customScreens"
import { projectConfigs } from "../projects"

function encontrarComponentIdsCustom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(encontrarComponentIdsCustom)
  }
  if (value === null || typeof value !== "object") return []

  const registro = value as Record<string, unknown>
  // A childRoute stores componentId beside targetResource instead of using
  // screen.kind, so coverage must inspect both config shapes.
  const ids = typeof registro.componentId === "string" ? [registro.componentId] : []

  return ids.concat(
    Object.values(registro).flatMap(encontrarComponentIdsCustom),
  )
}

describe("registry de telas custom", () => {
  it("registra e navega pela documentação executável", async () => {
    clearCustomScreens()
    registrarTelasCustom()
    const Documentation = getCustomScreen("documentation")
    expect(Documentation).toBeDefined()

    render(
      <BibliotecaThemeProvider>
        {createElement(Documentation!)}
      </BibliotecaThemeProvider>,
    )
    expect(screen.getByTestId("documentation-screen")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Biblioteca Global UI" })).toBeInTheDocument()

    // Menu lateral: JsonGrid já é a seção inicial (grade de dados).
    expect(screen.getByRole("heading", { name: "Grade de dados JSON" })).toBeInTheDocument()
    expect(screen.getByText("Livros cadastrados")).toBeInTheDocument()

    // Navega pelo menu lateral para outra seção.
    await userEvent.click(screen.getByRole("button", { name: /DynamicForm/ }))
    expect(screen.getByRole("heading", { name: "Formulário dinâmico" })).toBeInTheDocument()
    expect(screen.getByText("Como utilizar")).toBeInTheDocument()
  })

  it("registra a tela administrativa de prompts do GerenteAgentes", () => {
    clearCustomScreens()
    registrarTelasCustom()
    expect(getCustomScreen("gerenteagentes-prompts")).toBeDefined()
  })

  it("cobre todas as telas custom declaradas pelos projetos atuais", () => {
    clearCustomScreens()
    registrarTelasCustom()

    const ids = [
      ...new Set(Object.values(projectConfigs).flatMap(encontrarComponentIdsCustom)),
    ]

    expect(ids).toEqual([
      "documentation",
      "gerenteagentes-dashboard",
      "gerenteagentes-task-monitor",
      "gerenteagentes-isa-chat",
      "gerenteagentes-model-selection",
      "gerenteagentes-prompts",
      "sistema-adm-global-dashboard",
      "sistema-adm-global-hub-administrativo",
      "sistema-adm-global-hub-rh",
      "sistema-adm-global-hub-admin",
      "taqui-registro-encomenda",
      "taqui-painel-portaria",
      "taqui-notificacoes-morador",
    ])

    for (const id of ids) {
      expect(getCustomScreen(id), `tela custom não registrada: ${id}`).toBeDefined()
    }
  })
})
