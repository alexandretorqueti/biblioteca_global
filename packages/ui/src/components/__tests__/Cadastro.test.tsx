// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import Cadastro from "../Cadastro"
import type { DynamicField } from "../DynamicForm"
import type { CadastroDataSource, CustomAction } from "@biblioteca-global/shared"

// vitest roda com globals:false — sem auto-cleanup do RTL.
beforeEach(cleanup)

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

// ============================================================================
// Master-detail: lista de filhos no Cadastro
// ============================================================================

describe("Cadastro — master-detail (lista de filhos)", () => {
  it("exibe seção vazia quando não há filhos", async () => {
    const dataSource = dataSourceMock([
      { id: 1, nome: "Projeto A" },
    ])
    const filhoDataSource = dataSourceMock([])
    
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        children={[
          {
            childResource: "componentes",
            fkField: "projetoId",
            label: "Componentes",
            dataSource: filhoDataSource,
          },
        ]}
      />,
    )

    // Grid carrega async — espera o botão Editar da linha 1.
    const botaoEditar = await screen.findByRole("button", {
      name: /editar/i,
    })
    fireEvent.click(botaoEditar)

    // Seção de filhos aparece (label do primeiro filho).
    expect(await screen.findByText(/Componentes/)).toBeInTheDocument()
    
    // Texto "nenhum registro encontrado" pois a lista de filhos está vazia.
    expect(screen.getByText("Nenhum registro encontrado.")).toBeInTheDocument()
  })

  it("carrega e exibe lista de filhos filtrada por fkField", async () => {
    const paiDataSource = dataSourceMock([
      { id: 1, nome: "Projeto A" },
    ])
    
    const filhoList = [
      { id: 10, nome: "JsonGrid", projetoId: 1 },
      { id: 11, nome: "Cadastro", projetoId: 1 },
    ]
    const filhoDataSource = dataSourceMock(filhoList)
    
    render(
      <Cadastro
        dataSource={paiDataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        children={[
          {
            childResource: "componentes",
            fkField: "projetoId",
            label: "Componentes",
            dataSource: filhoDataSource,
          },
        ]}
      />,
    )

    // Grid carrega async — espera o botão Editar da linha 1.
    const botaoEditar = await screen.findByRole("button", {
      name: /editar/i,
    })
    fireEvent.click(botaoEditar)

    // A seção de filhos aparece com a contagem correta.
    expect(await screen.findByText(/Componentes \(2\)/)).toBeInTheDocument()
    
    // O dataSource filho foi chamado com o filtro correto.
    await waitFor(() => {
      expect(filhoDataSource.list).toHaveBeenCalledWith({
        filters: { projetoId: 1 },
      })
    })

    // As linhas dos filhos aparecem na tabela.
    expect(screen.getByText("JsonGrid")).toBeInTheDocument()
    expect(screen.getByText("Cadastro")).toBeInTheDocument()
  })

  it("atualiza a lista de filhos ao trocar o registro pai selecionado", async () => {
    const paiDataSource = dataSourceMock([
      { id: 1, nome: "Projeto A" },
      { id: 2, nome: "Projeto B" },
    ])
    
    const filhoDataSource = dataSourceMock([
      { id: 20, nome: "FieldJson", projetoId: 2 },
    ])
    
    render(
      <Cadastro
        dataSource={paiDataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        children={[
          {
            childResource: "componentes",
            fkField: "projetoId",
            label: "Componentes",
            dataSource: filhoDataSource,
          },
        ]}
      />,
    )

    // Grid carrega async — clica no primeiro botão Editar (Projeto A).
    const botoesEditar = await screen.findAllByRole("button", {
      name: /editar/i,
    })
    fireEvent.click(botoesEditar[0]!)

    // Filho para Projeto A (id=1) — não há dados mockados.
    expect(await screen.findByText(/Componentes/)).toBeInTheDocument()
    
    // Troca para o segundo registro (Projeto B, id=2).
    fireEvent.click(botoesEditar[1]!)
    
    // O dataSource filho é chamado com o filtro atualizado.
    await waitFor(() => {
      expect(filhoDataSource.list).toHaveBeenCalledWith({
        filters: { projetoId: 2 },
      })
    })

    // A contagem se atualiza para os filhos de Projeto B.
    expect(await screen.findByText(/Componentes \(1\)/)).toBeInTheDocument()
    expect(screen.getByText("FieldJson")).toBeInTheDocument()
  })

  it("não tenta carregar filhos quando nenhuma linha está selecionada", async () => {
    const paiDataSource = dataSourceMock([
      { id: 1, nome: "Projeto A" },
    ])
    
    const filhoDataSource = dataSourceMock([])
    
    render(
      <Cadastro
        dataSource={paiDataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        children={[
          {
            childResource: "componentes",
            fkField: "projetoId",
            label: "Componentes",
            dataSource: filhoDataSource,
          },
        ]}
      />,
    )

    // Só abre o formulário de criação (sem linha selecionada).
    fireEvent.click(screen.getByText("Novo projeto"))

    // A seção de filhos não deve aparecer (nenhuma linha selecionada).
    expect(screen.queryByText(/Componentes/)).not.toBeInTheDocument()

    // O dataSource filho nunca foi chamado.
    expect(filhoDataSource.list).not.toHaveBeenCalled()
  })
})

// ============================================================================
// St-9: Botões de ação com feedback de estado
// ============================================================================

const acoes: CustomAction[] = [
  { id: "sincronizar", label: "Sincronizar", method: "POST", path: "/sincronizar" },
  { id: "exportar", label: "Exportar CSV", method: "GET", path: "/exportar" },
]

const executeActionMock = vi.fn()

describe("Cadastro — botões de ação com feedback (st-9)", () => {
  beforeEach(() => {
    executeActionMock.mockClear()
  })

  it("renderiza botões de ação e desabilita durante execução", async () => {
    let resolveAcao!: (v: { message: string }) => void
    const exMock = vi.fn(
      () => new Promise<{ message: string }>((resolve) => {
        resolveAcao = resolve
      }),
    )

    render(
      <Cadastro
        dataSource={dataSourceMock([{ id: 1, nome: "Projeto A" }])}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        actions={acoes}
        executeAction={exMock}
      />,
    )

    // Botões devem estar habilitados
    const botoes = screen.getAllByRole("button")
    const btnSync = screen.getByText("Sincronizar")
    expect(btnSync).not.toBeDisabled()

    // Clicar no botão Sincronizar
    fireEvent.click(btnSync)

    // Durante execução: botão desabilitado e rótulo muda
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Executando Sincronizar..." })).toBeDisabled()
    })

    // Botão Exportar deve estar desabilitado também (execução em curso)
    const btnExport = screen.getByText("Exportar CSV")
    expect(btnExport).toBeDisabled()

    resolveAcao!({ message: "Sincronizado com sucesso." })

    await waitFor(() => {
      expect(screen.getByText("Sincronizado com sucesso.")).toBeInTheDocument()
    })
  })

  it("exibe alerta de erro quando a ação falha", async () => {
    const exMock = vi.fn(async () => {
      throw new Error("Endpoint indisponível")
    })

    render(
      <Cadastro
        dataSource={dataSourceMock([{ id: 1, nome: "Projeto A" }])}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        actions={acoes}
        executeAction={exMock}
      />,
    )

    const btnSync = screen.getByText("Sincronizar")
    fireEvent.click(btnSync)

    await waitFor(() => {
      expect(screen.getByText("Endpoint indisponível")).toBeInTheDocument()
    })
  })

  it("desabilita botões de ação quando executeAction é ausente", async () => {
    render(
      <Cadastro
        dataSource={dataSourceMock([{ id: 1, nome: "Projeto A" }])}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        actions={acoes}
      />,
    )

    const btnSync = screen.getByText("Sincronizar")
    expect(btnSync).toBeDisabled()
  })

  it("desabilita botão 'Novo projeto' durante create", async () => {
    const dataSource = dataSourceMock([])
    let resolveCreate: (v: Linha) => void
    const createMock = vi.fn(
      () => new Promise<Linha>((resolve) => {
        resolveCreate = resolve as any
      }),
    )
    dataSource.create = createMock

    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        actions={acoes}
        executeAction={executeActionMock}
      />,
    )

    const btnNovo = screen.getByText("Novo projeto")
    expect(btnNovo).not.toBeDisabled()

    fireEvent.click(btnNovo)

    // Preencher campo obrigatório para abrir o form
    await userEvent.type(screen.getByLabelText(/Nome\b/), "Projeto Teste")

    fireEvent.click(screen.getByText("Cadastrar"))

    // O botão 'Novo projeto' fica desabilitado porque actionState === "create"
    await waitFor(() => {
      expect(btnNovo).toBeDisabled()
    })
  })

  it("desabilita botão 'Excluir' durante delete", async () => {
    const dataSource = dataSourceMock([{ id: 1, nome: "Projeto A", config: { app: { name: "Teste" } } }])

    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        newLabel="Novo projeto"
        actions={acoes}
        executeAction={executeActionMock}
      />,
    )

    const btnExcluir = await screen.findByRole("button", { name: "Excluir" })
    expect(btnExcluir).not.toBeDisabled()

    // Clique no botão 'Excluir' da grid (dispara o dialog de confirmação)
    fireEvent.click(btnExcluir)

    // Confirmar a exclusão no dialog
    const btnConfirmar = await screen.findByRole("button", { name: "Excluir" })
    fireEvent.click(btnConfirmar)

    // Após a exclusão, deve aparecer o alerta de sucesso
    await waitFor(() => {
      expect(screen.getByText("Registro excluído com sucesso.")).toBeInTheDocument()
    })
  })
})

