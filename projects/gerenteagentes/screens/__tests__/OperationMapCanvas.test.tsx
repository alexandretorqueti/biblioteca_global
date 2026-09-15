// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import OperationMapCanvas from "../OperationMapCanvas"

describe("OperationMapCanvas — dimensionamento do container", () => {
  it("expõe o container por data-testid e permite expansão fluida", () => {
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

    const canvas = screen.getByTestId("operation-map-canvas")
    expect(canvas).toBeInTheDocument()
    expect(canvas).toHaveStyle({ width: "100%", minHeight: "100%", overflow: "visible" })
    expect(canvas).not.toHaveStyle({ maxWidth: "1800px" })
  })
})
