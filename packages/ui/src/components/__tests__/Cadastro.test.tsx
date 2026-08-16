// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach } from "vitest"
import Cadastro from "../Cadastro"
import type { DynamicField } from "../DynamicForm"
import type { CadastroDataSource } from "@biblioteca-global/shared"

// vitest roda com globals:false — sem auto-cleanup do RTL.
afterEach(cleanup)

type Linha = Record<string, unknown> & { id: number }

function dataSourceMock(
  linhas: Linha[] = [],
): CadastroDataSource<Linha> {
  return {
    list: vi.fn(async () => linhas),
    create: vi.fn(async (values) => ({
      id: 99,
      ...values,
    })),
    update: vi.fn(async (row, values) => ({ ...row, ...values })),
    remove: vi.fn(async () => undefined),
    getRowId: (row) => row.id,
  }
}

const camposBase: DynamicField[] = [
  { name: "nome", label: "Nome", type: "text", required: true },
  {
    name: "config",
    label: "Config (JSON)",
    type: "json",
    gridVisible: false,
    fullWidth: true,
  },
  {
    name: "interno",
    label: "Campo interno",
    type: "text",
    insertable: false,
  },
]

describe("Cadastro — flags de contexto do campo", () => {
  it("criação: campos insertable:false não aparecem; json entra como editor", async () => {
    const dataSource = dataSourceMock()
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
      />,
    )

    fireEvent.click(screen.getByText("Novo projeto"))

    // Campo interno (insertable: false) não aparece na criação.
    expect(
      screen.queryByLabelText(/Campo interno/),
    ).not.toBeInTheDocument()

    // Editor json em árvore presente (label + chaves do objeto vazio).
    expect(screen.getByText(/Config \(JSON\)/)).toBeInTheDocument()
    expect(screen.getAllByText("{").length).toBeGreaterThan(0)

    // Submit sem editar o JSON → config omitido (string vazia).
    await userEvent.type(screen.getByLabelText(/Nome\b/), "P")
    fireEvent.click(screen.getByText("Cadastrar"))

    await waitFor(() => {
      expect(dataSource.create).toHaveBeenCalledWith({
        nome: "P",
      })
    })
  })

  it("edição: editar valor na árvore → update recebe objeto atualizado", async () => {
    const dataSource = dataSourceMock([
      {
        id: 1,
        nome: "Biblioteca Global",
        config: { app: { name: "Biblioteca Global" }, groups: [] },
      },
    ])
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
      />,
    )

    const botaoEditar = await screen.findByRole("button", {
      name: /editar/i,
    })
    fireEvent.click(botaoEditar)

    // Árvore mostra o valor armazenado (escopo do diálogo — a grid também
    // exibe "Biblioteca Global" na coluna Nome).
    const dialog = screen.getByRole("dialog")
    const valor = await within(dialog).findByText("Biblioteca Global")
    expect(valor).toBeInTheDocument()

    // Edita o valor "Biblioteca Global" dentro da árvore.
    await userEvent.click(valor)
    valor.textContent = "Biblioteca Global Editado"
    fireEvent.blur(valor)

    // Espera o eco da edição na árvore (blur é assíncrono) antes de salvar.
    await within(dialog).findByText("Biblioteca Global Editado")

    fireEvent.click(screen.getByText("Salvar alterações"))

    await waitFor(() => {
      expect(dataSource.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({
          config: expect.objectContaining({
            app: expect.objectContaining({
              name: "Biblioteca Global Editado",
            }),
          }),
        }),
      )
    })
  })

  it("edição: campos editable:false não aparecem; json vem serializado", async () => {
    const dataSource = dataSourceMock([
      {
        id: 1,
        nome: "Biblioteca Global",
        config: { app: { name: "Biblioteca Global" }, groups: [] },
      },
    ])
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
      />,
    )

    // Grid carrega async — espera o botão Editar da linha 1.
    const botaoEditar = await screen.findByRole("button", {
      name: /editar/i,
    })
    fireEvent.click(botaoEditar)

    // JSON do registro renderizado na árvore do editor.
    const dialog = screen.getByRole("dialog")
    expect(
      await within(dialog).findByText("Biblioteca Global"),
    ).toBeInTheDocument()

    // Campo interno com insertable:false aparece na EDIÇÃO (flags
    // independentes: criação → insertable; edição → editable).
    expect(
      screen.getByLabelText(/Campo interno/),
    ).toBeInTheDocument()
  })

  it("grid: campo gridVisible:false não vira coluna", async () => {
    const dataSource = dataSourceMock([
      {
        id: 1,
        nome: "Biblioteca Global",
        config: { app: { name: "Biblioteca Global" }, groups: [] },
      },
    ])
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText("Biblioteca Global")).toBeInTheDocument()
    })

    // A coluna Config (JSON) não aparece na grid.
    const colunas = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent ?? "")
    expect(colunas).not.toContain("Config (JSON)")
    expect(colunas).toContain("Nome")
  })
})
