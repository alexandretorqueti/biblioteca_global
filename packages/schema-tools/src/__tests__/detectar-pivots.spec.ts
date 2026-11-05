/**
 * Detecção de pivots N:N puros (detectar-pivots.ts) e aceitação de campos
 * virtuais de pivot na validação da config contra o schema.
 */
import { describe, expect, it } from "vitest"
import {
  bigint,
  mysqlTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import * as gestaoSchema from "../../../../projects/gestao-de-tarefas-global/schema"
import {
  camposPivotDoResource,
  coletarTabelas,
  ConfigInvalidaError,
  detectarPivots,
  validarConfigContraSchema,
} from "../index"

// ── Fixtures mínimas ────────────────────────────────────────────────────────

const itens = mysqlTable("itens", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  nome: varchar("nome", { length: 80 }).notNull(),
})

const categorias = mysqlTable("categorias", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  nome: varchar("nome", { length: 80 }).notNull(),
})

/** Pivot puro: id + 2 FKs para tabelas diferentes. */
const itemCategorias = mysqlTable(
  "item_categorias",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    itemId: bigint("item_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => itens.id),
    categoriaId: bigint("categoria_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => categorias.id),
  },
  (t) => [unique("uq").on(t.itemId, t.categoriaId)],
)

/** Auto-referência: NÃO é pivot (ex.: tarefa_dependencias do Motor). */
const links = mysqlTable("links", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  origemId: bigint("origem_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => itens.id),
  destinoId: bigint("destino_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => itens.id),
})

/** Com coluna extra (timestamp): NÃO é pivot puro. */
const vinculos = mysqlTable("vinculos", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  itemId: bigint("item_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => itens.id),
  categoriaId: bigint("categoria_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => categorias.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

const tabelasFixture = {
  itens,
  categorias,
  item_categorias: itemCategorias,
  links,
  vinculos,
}

describe("detectarPivots", () => {
  it("detecta pivot puro e ignora auto-referência e tabela com coluna extra", () => {
    const pivots = detectarPivots(tabelasFixture)
    expect(pivots.map((p) => p.pivot)).toEqual(["item_categorias"])
  })

  it("detecta tarefa_tags no schema real de gestao-de-tarefas-global", () => {
    const tabelas = coletarTabelas(gestaoSchema as unknown as Record<string, unknown>)
    const pivots = detectarPivots(tabelas)
    expect(pivots.map((p) => p.pivot)).toEqual(["tarefa_tags"])
  })

  it("camposPivotDoResource expõe o resource oposto em cada lado", () => {
    const emItens = camposPivotDoResource(tabelasFixture, "itens")
    expect(emItens).toHaveLength(1)
    expect(emItens[0]).toMatchObject({
      campo: "categorias",
      pivot: "item_categorias",
      fkPaiProp: "itemId",
      fkOpostoProp: "categoriaId",
      resourceOposto: "categorias",
    })

    const emCategorias = camposPivotDoResource(tabelasFixture, "categorias")
    expect(emCategorias).toHaveLength(1)
    expect(emCategorias[0]).toMatchObject({
      campo: "itens",
      fkPaiProp: "categoriaId",
      fkOpostoProp: "itemId",
    })

    expect(camposPivotDoResource(tabelasFixture, "links")).toEqual([])
  })

  it("schema real: tarefas ganha campo virtual 'tags' e tags ganha 'tarefas'", () => {
    const tabelas = coletarTabelas(gestaoSchema as unknown as Record<string, unknown>)
    expect(camposPivotDoResource(tabelas, "tarefas")).toEqual([
      expect.objectContaining({ campo: "tags", pivot: "tarefa_tags", fkPaiProp: "tarefaId", fkOpostoProp: "tagId" }),
    ])
    expect(camposPivotDoResource(tabelas, "tags")).toEqual([
      expect.objectContaining({ campo: "tarefas", pivot: "tarefa_tags", fkPaiProp: "tagId", fkOpostoProp: "tarefaId" }),
    ])
    expect(camposPivotDoResource(tabelas, "areas")).toEqual([])
  })
})

describe("validarConfigContraSchema — campo virtual de pivot", () => {
  const tabelas = coletarTabelas(gestaoSchema as unknown as Record<string, unknown>)

  function configComField(fieldName: string): GeradorSistemaConfig {
    return {
      app: { name: "Teste" },
      groups: [
        {
          id: "g",
          label: "G",
          items: [
            {
              id: "tarefas",
              label: "Tarefas",
              path: "tarefas",
              screen: {
                kind: "cadastro",
                resource: "tarefas",
                fields: [
                  {
                    name: fieldName,
                    label: "Campo",
                    type: "multipleChoice",
                    multipleChoice: { resource: "tags", idField: "id", displayField: "nome", multiple: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
  }

  it("aceita o campo virtual do pivot ('tags' em tarefas)", () => {
    expect(() => validarConfigContraSchema(configComField("tags"), tabelas)).not.toThrow()
  })

  it("continua rejeitando campo que não é coluna nem pivot", () => {
    expect(() =>
      validarConfigContraSchema(configComField("inexistente"), tabelas),
    ).toThrow(ConfigInvalidaError)
  })
})
