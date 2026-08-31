// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import { ThemeProvider, createTheme } from "@mui/material/styles"
import GeradorSistema from "../GeradorSistema"
import { registerCustomScreens, clearCustomScreens } from "../../registry"
import type { GeradorSistemaRuntime } from "../../types"
import type { CadastroDataSource } from "@biblioteca-global/shared"

const config: GeradorSistemaConfig = {
  app: { name: "Sistema Demo", logo: "dashboard" },
  groups: [
    {
      id: "cadastros",
      label: "Cadastros",
      items: [
        {
          id: "componentes",
          label: "Componentes",
          path: "/componentes",
          icon: "table",
          screen: {
            kind: "cadastro",
            resource: "componentes",
            title: "Componentes UI",
            fields: [
              { name: "nome", label: "Nome", type: "text" },
            ],
          },
        },
        {
          id: "documentacao",
          label: "Documentação",
          path: "/documentacao",
          screen: { kind: "custom", componentId: "documentation" },
        },
      ],
    },
  ],
}

function dataSourceFake(
  rows: Array<Record<string, string | number | boolean>> = [],
): CadastroDataSource<Record<string, unknown>> {
  return {
    list: async () => rows,
    create: async (values) => ({ id: rows.length + 1, ...values }),
    update: async (row, values) => ({ ...row, ...values }),
    remove: async () => undefined,
    getRowId: (row) => Number(row.id),
  }
}

function renderSistema(runtime: Partial<GeradorSistemaRuntime> = {}) {
  const dataSource = dataSourceFake([{ id: 1, nome: "JsonGrid" }])
  return render(
    <ThemeProvider theme={createTheme()}>
      <GeradorSistema
        config={config}
        runtime={{
          getDataSource: () => dataSource,
          ...runtime,
        }}
      />
    </ThemeProvider>,
  )
}

describe("GeradorSistema (config serializável)", () => {
  afterEach(() => {
    clearCustomScreens()
    cleanup()
  })

  it("renderiza o menu com os grupos e rotas da config", () => {
    renderSistema()
    expect(screen.getByText("Sistema Demo")).toBeInTheDocument()
    expect(screen.getAllByText("Cadastros").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Componentes").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Documentação").length).toBeGreaterThan(0)
  })

  it("rota cadastro monta a tela com o dataSource do resource", async () => {
    renderSistema()
    // Rota inicial = primeira rota (componentes) → Cadastro com listagem.
    expect(await screen.findByText("Componentes UI")).toBeInTheDocument()
    expect(await screen.findByText("JsonGrid")).toBeInTheDocument()
  })

  it("navegação atualiza o breadcrumb e troca de tela", async () => {
    const user = userEvent.setup()
    renderSistema()

    await user.click(screen.getAllByText("Documentação").at(0)!)
    expect(
      await screen.findByText(
        "Tela custom \"documentation\" não registrada no registry.",
      ),
    ).toBeInTheDocument()
  })

  it("rota custom resolve o componente registrado no registry", async () => {
    registerCustomScreens({
      documentation: () => <div>Documentação da biblioteca</div>,
    })
    const user = userEvent.setup()
    renderSistema()

    await user.click(screen.getAllByText("Documentação").at(0)!)
    expect(
      await screen.findByText("Documentação da biblioteca"),
    ).toBeInTheDocument()
  })

  it("childRoute custom recebe a linha pai clicada (parentRow) como props", async () => {
    const configComChild: GeradorSistemaConfig = {
      app: { name: "Sistema Demo", logo: "dashboard" },
      groups: [
        {
          id: "cadastros",
          label: "Cadastros",
          items: [
            {
              id: "projetos",
              label: "Projetos",
              path: "/projetos",
              icon: "account_tree",
              screen: {
                kind: "cadastro",
                resource: "projetos_captados",
                title: "Projetos",
                fields: [{ name: "nome", label: "Nome", type: "text" }],
                childRoutes: [
                  {
                    id: "modelos",
                    label: "Modelos",
                    targetResource: "projetos_captados",
                    componentId: "tela-modelos",
                    filterField: "projetoId",
                    title: "Fila de Modelos",
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    registerCustomScreens({
      "tela-modelos": (props) => (
        <div data-testid="tela-modelos">
          pai:{String(props.parentRow?.slug ?? "nenhum")}
        </div>
      ),
    })
    const dataSource = dataSourceFake([
      { id: 7, nome: "Biblioteca Global", slug: "biblioteca-global" },
    ])
    const user = userEvent.setup()
    render(
      <ThemeProvider theme={createTheme()}>
        <GeradorSistema
          config={configComChild}
          runtime={{ getDataSource: () => dataSource }}
        />
      </ThemeProvider>,
    )

    // Grid carregou a linha do projeto
    expect(await screen.findByText("Biblioteca Global")).toBeInTheDocument()
    // Clica na childRoute da linha → tela custom montada com o contexto da linha
    await user.click(screen.getByRole("button", { name: "Modelos" }))
    const tela = await screen.findByTestId("tela-modelos")
    expect(tela).toHaveTextContent("pai:biblioteca-global")
  })

  it("runtime.resolveIcon sobrescreve o mapa padrão de ícones", () => {
    renderSistema({
      resolveIcon: (name) => <span data-testid={`icon-${name}`} />,
    })
    expect(screen.getByTestId("icon-dashboard")).toBeInTheDocument()
  })
})
