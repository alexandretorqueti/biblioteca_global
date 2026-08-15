// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { createElement } from "react"
import { BibliotecaThemeProvider, clearCustomScreens, getCustomScreen } from "@biblioteca-global/ui"
import { registrarTelasCustom } from "../customScreens"

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

    await userEvent.click(screen.getByRole("tab", { name: "Grid" }))
    expect(screen.getByText("Catálogo")).toBeInTheDocument()
  })
})
