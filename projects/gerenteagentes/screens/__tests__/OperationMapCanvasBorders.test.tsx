// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import OperationMapCanvas from "../OperationMapCanvas"

describe("OperationMapCanvas — bordas coloridas sem sombras", () => {
  it("não aplica sombra aos quadros das estações", () => {
    render(
      <BibliotecaThemeProvider>
        <OperationMapCanvas
          tarefas={[]}
          selectedTaskId=""
          projetos={[]}
          onSelectTask={() => undefined}
        />
      </BibliotecaThemeProvider>,
    )

    const stations = screen.getAllByTestId(/^operation-station-/)
    expect(stations).toHaveLength(11)

    stations.forEach(station => {
      const style = window.getComputedStyle(station)
      // Paper com variant="outlined" não tem elevation, portanto boxShadow é vazio ou "none"
      expect(style.boxShadow).toBe(""  )
    })
  })

  it("aplica borda colorida de 3px em todos os lados dos quadros", () => {
    // Renderizar com pelo menos uma tarefa para que as estações apareçam
    render(
      <BibliotecaThemeProvider>
        <OperationMapCanvas
          tarefas={[
            { id: 1, titulo: "Tarefa teste", status: "draft", projetoId: 1, projetoNome: "Projeto Teste" }
          ]}
          selectedTaskId=""
          projetos={[{ id: 1, nome: "Projeto Teste" }]}
          onSelectTask={() => undefined}
        >
        </OperationMapCanvas>
      </BibliotecaThemeProvider>,
    )

    const station = screen.getByTestId("operation-station-draft")
    const style = window.getComputedStyle(station)
    // O MUI aplica border-width como "3px 3px 3px 3px" quando usamos border: 3
    expect(style.borderWidth.startsWith("3px")).toBe(true)
  })
})
