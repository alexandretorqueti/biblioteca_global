// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { useTheme } from "@mui/material"
import { BibliotecaThemeProvider } from "../BibliotecaThemeProvider"

function ThemeProbe() {
  const theme = useTheme()
  return <span data-testid="theme-mode">{theme.palette.mode}</span>
}

describe("BibliotecaThemeProvider", () => {
  it("sincroniza o tema quando initialTheme muda", async () => {
    const view = render(
      <BibliotecaThemeProvider initialTheme="claro">
        <ThemeProbe />
      </BibliotecaThemeProvider>,
    )
    expect(screen.getByTestId("theme-mode")).toHaveTextContent("light")

    view.rerender(
      <BibliotecaThemeProvider initialTheme="escuro">
        <ThemeProbe />
      </BibliotecaThemeProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("dark")
    })
  })
})
