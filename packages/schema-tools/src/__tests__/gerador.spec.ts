import { describe, expect, it } from "vitest"
import {
  bigint,
  boolean,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import {
  ConfigInvalidaError,
  gerarFields,
  humanizarNome,
  montarConfigInicial,
  TipoNaoSuportadoError,
  validarConfigContraSchema,
} from "../index"
import type { FormAnnotationsPorTabela } from "../index"

const pedidos = mysqlTable("pedidos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  cliente: varchar("cliente", { length: 120 }).notNull(),
  valorTotal: int("valor_total").notNull(),
  pago: boolean("pago").notNull().default(false),
  situacao: mysqlEnum("situacao", ["aberto", "pago", "cancelado"]).notNull(),
  observacao: text("observacao"),
  metadata: json("metadata"),
})

const anotacoes: FormAnnotationsPorTabela = {
  pedidos: {
    cliente: { label: "Cliente", fullWidth: true, maxLength: 120 },
    metadata: { type: "textarea", label: "Metadados" },
  },
}

describe("gerarFields", () => {
  it("coluna com annotation → field com label/tipo/fullWidth da annotation", () => {
    const fields = gerarFields(pedidos, "pedidos", anotacoes.pedidos)
    const cliente = fields.find((f) => f.name === "cliente")
    expect(cliente).toEqual({
      name: "cliente",
      label: "Cliente",
      type: "text",
      required: true,
      fullWidth: true,
      maxLength: 120,
    })
  })

  it("coluna sem annotation → defaults sensatos (label humanizado, tipo derivado)", () => {
    const fields = gerarFields(pedidos, "pedidos", anotacoes.pedidos)
    const valor = fields.find((f) => f.name === "valor_total")
    expect(valor).toMatchObject({
      label: "Valor total",
      type: "number",
      required: true,
    })
    const pago = fields.find((f) => f.name === "pago")
    expect(pago).toMatchObject({
      label: "Pago",
      type: "switch",
      required: false, // notNull com default → opcional
    })
    const situacao = fields.find((f) => f.name === "situacao")
    expect(situacao).toMatchObject({ type: "select", required: true })
    expect(situacao?.options?.map((o) => o.value)).toEqual([
      "aberto",
      "pago",
      "cancelado",
    ])
    const observacao = fields.find((f) => f.name === "observacao")
    expect(observacao).toMatchObject({ type: "textarea", required: false })
  })

  it("PK autoincrement fica fora do formulário", () => {
    const fields = gerarFields(pedidos, "pedidos", anotacoes.pedidos)
    expect(fields.find((f) => f.name === "id")).toBeUndefined()
  })

  it("tipo não suportado → erro claro", () => {
    expect(() => gerarFields(pedidos, "pedidos", {})).toThrow(
      TipoNaoSuportadoError,
    )
    expect(() => gerarFields(pedidos, "pedidos", {})).toThrow(
      /metadata.*pedidos/,
    )
  })

  it("tipo não suportado com annotation de tipo → gera o field", () => {
    const fields = gerarFields(pedidos, "pedidos", anotacoes.pedidos)
    const metadata = fields.find((f) => f.name === "metadata")
    expect(metadata).toMatchObject({ label: "Metadados", type: "textarea" })
  })

  it("humanizarNome", () => {
    expect(humanizarNome("valor_total")).toBe("Valor total")
    expect(humanizarNome("nome")).toBe("Nome")
  })
})

describe("montarConfigInicial", () => {
  const base: GeradorSistemaConfig = {
    app: { name: "Teste" },
    groups: [
      {
        id: "g",
        label: "G",
        items: [
          {
            id: "doc",
            label: "Doc",
            path: "doc",
            screen: { kind: "custom", componentId: "documentation" },
          },
        ],
      },
    ],
  }

  it("acrescenta telas cadastro geradas das tabelas não referenciadas", () => {
    const config = montarConfigInicial(base, { pedidos }, anotacoes)
    expect(config.groups).toHaveLength(2)
    const cadastros = config.groups.at(1)
    expect(cadastros?.id).toBe("cadastros")
    const tela = cadastros?.items.at(0)
    expect(tela?.screen.kind).toBe("cadastro")
    if (tela?.screen.kind === "cadastro") {
      expect(tela.screen.resource).toBe("pedidos")
      expect(tela.screen.fields?.length).toBeGreaterThan(0)
    }
  })

  it("tabela já referenciada na base não é duplicada", () => {
    const baseComPedidos: GeradorSistemaConfig = {
      app: { name: "Teste" },
      groups: [
        {
          id: "g",
          label: "G",
          items: [
            {
              id: "pedidos",
              label: "Pedidos",
              path: "pedidos",
              screen: { kind: "cadastro", resource: "pedidos" },
            },
          ],
        },
      ],
    }
    const config = montarConfigInicial(baseComPedidos, { pedidos }, anotacoes)
    expect(config).toBe(baseComPedidos)
  })
})

describe("validarConfigContraSchema", () => {
  const telaCom = (
    resource: string,
    overrides?: { fields?: Array<{ name: string; label?: string; type?: string }>; hiddenColumns?: string[] },
  ): GeradorSistemaConfig => ({
    app: { name: "X" },
    groups: [
      {
        id: "g",
        label: "G",
        items: [
          {
            id: "i",
            label: "I",
            path: "p",
            screen: {
              kind: "cadastro",
              resource,
              overrides: overrides as never,
            },
          },
        ],
      },
    ],
  })

  it("config válida passa", () => {
    expect(() =>
      validarConfigContraSchema(telaCom("pedidos"), { pedidos }),
    ).not.toThrow()
  })

  it("resource inexistente no schema → rejeita", () => {
    expect(() =>
      validarConfigContraSchema(telaCom("nao_existe"), { pedidos }),
    ).toThrow(ConfigInvalidaError)
  })

  it("resource do core é aceito (módulos específicos)", () => {
    expect(() =>
      validarConfigContraSchema(telaCom("usuarios"), { pedidos }),
    ).not.toThrow()
  })

  it("override de campo inexistente → rejeita com o problema", () => {
    const config = telaCom("pedidos", {
      fields: [{ name: "campo_fantasma", label: "X", type: "text" }],
    })
    expect(() => validarConfigContraSchema(config, { pedidos })).toThrow(
      /campo_fantasma/,
    )
  })

  it("hiddenColumn inexistente → rejeita", () => {
    const config = telaCom("pedidos", { hiddenColumns: ["nao_existe"] })
    expect(() => validarConfigContraSchema(config, { pedidos })).toThrow(
      /nao_existe/,
    )
  })
})
