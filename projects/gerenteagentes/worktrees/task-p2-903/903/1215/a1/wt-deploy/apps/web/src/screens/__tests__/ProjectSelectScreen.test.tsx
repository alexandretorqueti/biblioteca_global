// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import ProjectSelectScreen from "../ProjectSelectScreen"

const selectProject = vi.fn(async () => undefined)

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    usuario: { nome: "Alexandre" },
    projetos: [
      {
        id: 2,
        nome: "Documentação",
        slug: "documentacao",
        perfil: "admin",
      },
    ],
    selectProject,
  }),
}))

describe("ProjectSelectScreen", () => {
  it("navega para /app depois de selecionar o projeto", async () => {
    render(
      <MemoryRouter initialEntries={["/select"]}>
        <Routes>
          <Route path="/select" element={<ProjectSelectScreen />} />
          <Route path="/app" element={<div>Sistema carregado</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByTestId("project-option-documentacao"))

    await waitFor(() => {
      expect(selectProject).toHaveBeenCalledWith(2)
      expect(screen.getByText("Sistema carregado")).toBeInTheDocument()
    })
  })
})
