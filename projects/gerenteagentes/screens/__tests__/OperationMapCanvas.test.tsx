// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import OperationMapCanvas from "../OperationMapCanvas"

describe("OperationMapCanvas — largura uniforme das estações", () => {
  it("aplica a mesma largura a todas as estações do mapa", () => {
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

    const dimensions = stations.map(station => {
      const style = window.getComputedStyle(station)
      return [style.width, style.minWidth, style.maxWidth]
    })
    expect(new Set(dimensions.map(dimension => dimension.join("|"))).size).toBe(1)
  })
})
