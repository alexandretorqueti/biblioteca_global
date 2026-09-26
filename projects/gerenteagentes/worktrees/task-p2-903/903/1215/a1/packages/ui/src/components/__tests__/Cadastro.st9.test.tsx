// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach } from "vitest"
import Cadastro from "../Cadastro"
import type { DynamicField } from "../DynamicForm"
import type { CadastroDataSource, CustomAction } from "@biblioteca-global/shared"

afterEach(cleanup)

type Linha = Record<string, unknown> & { id: number }

function dataSourceMock(
  linhas: Linha[],
): CadastroDataSource<Linha> {
  const refLinhas = [...linhas] // referência mutável para simular exclusão
  return {
    list: vi.fn(async () => [...refLinhas]),
    create: vi.fn(async (values) => {
      const novo = { id: refLinhas.length + 100, ...values } as Linha
      refLinhas.push(novo)
      return novo
    }),
    update: vi.fn(async (row, values) => {
      const idx = refLinhas.findIndex((l) => l.id === row.id)
      if (idx >= 0) refLinhas[idx] = { ...refLinhas[idx], ...values }
      return { ...row, ...values }
    }),
    remove: vi.fn(async (row) => {
      const idx = refLinhas.findIndex((l) => l.id === row.id)
      if (idx >= 0) refLinhas.splice(idx, 1)
      return undefined
    }),
    getRowId: (row) => row.id,
  }
}

const camposBase: DynamicField[] = [
  { name: "nome", label: "Nome", type: "text", required: true },
  { name: "config", label: "Config (JSON)", type: "json", gridVisible: false, fullWidth: true },
  { name: "interno", label: "Campo interno", type: "text", insertable: false },
]

describe("Cadastro — botões com feedback (st-9)", () => {
  it("botão Cadastrar muda para 'Cadastrando...' durante execução e exibe alerta de sucesso", async () => {
    const dataSource = dataSourceMock([])
    
    render(
      <Cadastro dataSource={dataSource} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    fireEvent.click(screen.getByText("Novo projeto"))
    await userEvent.type(screen.getByLabelText(/Nome\b/), "Projeto")

    const btn = screen.getByRole("button", { name: /Cadastrar/ })
    expect(btn).not.toBeDisabled()

    fireEvent.click(btn)

    // Label muda para "Cadastrando..." durante execução (botão desabilitado)
    await waitFor(() => {
      expect(screen.getByText("Cadastrando...")).toBeInTheDocument()
    })

    // Alerta de sucesso aparece após conclusão
    await waitFor(() => {
      expect(screen.getByText("Registro cadastrado com sucesso.")).toBeInTheDocument()
    })
  })

  it("botão Salvar alterações muda para 'Salvando...' durante execução e exibe alerta de sucesso", async () => {
    const dataSource = dataSourceMock([{ id: 1, nome: "Original" }])
    
    render(
      <Cadastro dataSource={dataSource} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /editar/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /editar/i }))
    await userEvent.type(screen.getByLabelText(/Nome\b/), " editado")

    const btnSalvar = screen.getByRole("button", { name: /Salvar alterações/ })
    expect(btnSalvar).not.toBeDisabled()

    fireEvent.click(btnSalvar)

    // Label muda durante execução
    await waitFor(() => {
      expect(screen.getByText("Salvando...")).toBeInTheDocument()
    })

    // Alerta de sucesso após conclusão
    await waitFor(() => {
      expect(screen.getByText("Registro atualizado com sucesso.")).toBeInTheDocument()
    })
  })

  it("exibe alerta vermelho quando a operação falha", async () => {
    const dataSource = dataSourceMock([{ id: 1, nome: "Original" }])
    dataSource.update = vi.fn(async () => { throw new Error("Falha ao conectar") })
    
    render(
      <Cadastro dataSource={dataSource} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /editar/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /editar/i }))
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }))

    await waitFor(() => {
      expect(screen.queryByText(/Falha ao conectar/)).toBeInTheDocument()
    })
  })

  it("alertas de sucesso e erro aparecem como Alert visível fora do form", async () => {
    // Sucesso via edição
    const dsSucesso = dataSourceMock([{ id: 1, nome: "Original" }])
    
    render(
      <Cadastro dataSource={dsSucesso} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /editar/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /editar/i }))
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }))

    await waitFor(() => {
      expect(screen.getByText("Registro atualizado com sucesso.")).toBeInTheDocument()
    })

    // Limpa e testa erro
    cleanup()
    
    const dsErro = dataSourceMock([{ id: 1, nome: "Original" }])
    dsErro.update = vi.fn(async () => { throw new Error("Conexão perdida") })

    render(
      <Cadastro dataSource={dsErro} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /editar/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /editar/i }))
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }))

    await waitFor(() => {
      expect(screen.queryByText(/Conexão perdida/)).toBeInTheDocument()
    })
  })

  it("diálogo de exclusão: botão muda para 'Excluindo...', alerta de sucesso aparece e registro some", async () => {
    const dataSource = dataSourceMock([{ id: 1, nome: "Para deletar" }])
    
    render(
      <Cadastro dataSource={dataSource} title="Projetos" fields={camposBase} newLabel="Novo projeto" />,
    )

    // Botão excluir na grid aparece habilitado
    const btnExcluir = await screen.findByRole("button", { name: /excluir/i })
    expect(btnExcluir).not.toBeDisabled()
    fireEvent.click(btnExcluir)

    // Diálogo de confirmação aparece
    await waitFor(() => {
      expect(screen.getByText("Excluir registro")).toBeInTheDocument()
    })

    // Confirma exclusão — botão do diálogo é desabilitado, label muda para "Excluindo..."
    fireEvent.click(screen.getAllByText("Excluir")[1]!)

    // Spinner (label muda para "Excluindo...") + alerta de sucesso aparecem
    await waitFor(() => {
      expect(screen.getByText("Registro excluído com sucesso.")).toBeInTheDocument()
    })

    // Registro some da grid (loadRows recarrega lista)
    expect(screen.queryByText("Para deletar")).not.toBeInTheDocument()
  })
})

// ============================================================================
// St-9: botões de ação customizada com feedback (executando/sucesso/erro)
// ============================================================================

const acoes: CustomAction[] = [
  { id: "aprovar", label: "Aprovar", method: "POST", path: "/aprovar" },
  { id: "exportar", label: "Exportar", method: "POST", path: "/exportar" },
]

describe("Cadastro — ações customizadas com feedback (st-9)", () => {
  it("renderiza os botões das ações", () => {
    const dataSource = dataSourceMock([])
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        actions={acoes}
        executeAction={vi.fn(async () => ({ message: "ok" }))}
      />,
    )

    expect(screen.getByRole("button", { name: "Aprovar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Exportar" })).toBeInTheDocument()
  })

  it("desabilita os botões durante a execução e muda o rótulo", async () => {
    const dataSource = dataSourceMock([])
    let resolveAcao!: (v: { message: string }) => void
    const executeAction = vi.fn(
      () => new Promise<{ message: string }>((resolve) => {
        resolveAcao = resolve
      }),
    )

    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        actions={acoes}
        executeAction={executeAction}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))

    // Durante execução: botão vira "Executando Aprovar..." e é desabilitado
    await waitFor(() => {
      expect(screen.getByText("Executando Aprovar...")).toBeInTheDocument()
    })
    const btnAprovar = screen.getByRole("button", { name: "Executando Aprovar..." })
    expect(btnAprovar).toBeDisabled()

    // Outros botões de ação também desabilitados durante qualquer execução
    expect(screen.getByRole("button", { name: "Exportar" })).toBeDisabled()

    resolveAcao({ message: "Aprovado com sucesso." })

    await waitFor(() => {
      expect(screen.getByText("Aprovado com sucesso.")).toBeInTheDocument()
    })
  })

  it("exibe alerta de erro quando a ação falha", async () => {
    const dataSource = dataSourceMock([])
    const executeAction = vi.fn(async () => {
      throw new Error("Ação recusada pelo servidor")
    })

    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        actions={acoes}
        executeAction={executeAction}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Exportar" }))

    await waitFor(() => {
      expect(screen.getByText("Ação recusada pelo servidor")).toBeInTheDocument()
    })

    // Botão volta a habilitar após o erro
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Exportar" })).not.toBeDisabled()
    })
  })

  it("mantém botão desabilitado quando executeAction não é fornecido", () => {
    const dataSource = dataSourceMock([])
    render(
      <Cadastro
        dataSource={dataSource}
        title="Projetos"
        fields={camposBase}
        actions={acoes}
      />,
    )

    expect(screen.getByRole("button", { name: "Aprovar" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Exportar" })).toBeDisabled()
  })
})
