// @vitest-environment jsdom
/**
 * Testes do JsonGrid — foco na ocultação de colunas JSON
 * (decisão do Alexandre 2026-08-15: campos JSON não aparecem na grid).
 */
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import JsonGrid from "../JsonGrid"

const linhas = [
  {
    id: 1,
    nome: "Projeto A",
    config: { tema: "escuro", icone: "box" },
    tags: ["ui", "web"],
  },
  {
    id: 2,
    nome: "Projeto B",
    config: { tema: "claro" },
    tags: [],
  },
]

describe("JsonGrid — colunas JSON", () => {
  it("oculta colunas JSON (objeto/array) por padrão", () => {
    render(<JsonGrid data={linhas} />)
    expect(screen.getByText("Projeto A")).toBeInTheDocument()
    expect(screen.getByText("Projeto B")).toBeInTheDocument()
    expect(screen.queryByText("Config")).not.toBeInTheDocument()
    expect(screen.queryByText("Tags")).not.toBeInTheDocument()
    expect(screen.queryByText(/tema/i)).not.toBeInTheDocument()
  })

  it("mantém colunas com config type: \"json\" ocultas mesmo com showJsonColumns=false", () => {
    render(
      <JsonGrid
        data={linhas}
        columns={{ config: { type: "json" } }}
      />,
    )
    expect(screen.queryByText("Config")).not.toBeInTheDocument()
  })

  it("showJsonColumns=true exibe as colunas JSON", () => {
    render(<JsonGrid data={linhas} showJsonColumns />)
    expect(screen.getByText("Config")).toBeInTheDocument()
    expect(screen.getByText("Tags")).toBeInTheDocument()
    expect(screen.getByText(/tema.*escuro/)).toBeInTheDocument()
  })

  it("coluna com valor null não é tratada como JSON", () => {
    render(
      <JsonGrid
        data={[{ id: 1, nome: "Sem config", config: null }]}
      />,
    )
    expect(screen.getByText("Sem config")).toBeInTheDocument()
    // null/undefined → célula vazia (sem o rótulo "Nulo").
    expect(screen.queryByText("Nulo")).not.toBeInTheDocument()
  })
})
