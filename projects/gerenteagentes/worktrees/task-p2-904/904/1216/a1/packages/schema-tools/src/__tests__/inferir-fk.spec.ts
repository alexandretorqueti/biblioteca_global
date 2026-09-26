import { describe, expect, it, vi } from "vitest"
import { bigint, int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { gerarFields, inferirFk, resolverDisplayField } from "../index"

// Tabelas de teste para inferência de FK
const condominios = mysqlTable("condominios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 120 }).notNull(),
})

const unidades = mysqlTable("unidades", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  label: varchar("label", { length: 50 }).notNull(),
  condominioId: bigint("condominio_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => condominios.id, { onDelete: "cascade" }),
})

// Tabela sem coluna legível (só id)
const tabelaSemColunaLegivel = mysqlTable("tabela_sem_legivel", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  codigo: int("codigo").notNull(),
})

const tabelaComFkSemLegivel = mysqlTable("tabela_com_fk_sem_legivel", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  refId: bigint("ref_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tabelaSemColunaLegivel.id),
})

// Tabela com coluna "titulo"
const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
})

const subtarefas = mysqlTable("subtarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id, { onDelete: "cascade" }),
})

describe("inferirFk", () => {
  it("detecta FK e resolve displayField por heurística (nome)", () => {
    const fk = inferirFk(unidades, unidades.condominioId)
    expect(fk).toBeDefined()
    expect(fk?.resource).toBe("condominios")
    expect(fk?.displayField).toBe("nome")
    expect(fk?.inferido).toBe(true)
    expect(fk?.fallbackId).toBe(false)
  })

  it("detecta FK e resolve displayField por heurística (label)", () => {
    const fk = inferirFk(unidades, unidades.condominioId)
    // unidades tem FK para condominios, que tem "nome"
    expect(fk?.displayField).toBe("nome")
  })

  it("detecta FK e resolve displayField por heurística (titulo)", () => {
    const fk = inferirFk(subtarefas, subtarefas.tarefaId)
    expect(fk).toBeDefined()
    expect(fk?.resource).toBe("tarefas")
    expect(fk?.displayField).toBe("titulo")
  })

  it("fallback para primeira coluna string quando nenhum candidato nomeado existe", () => {
    // tabelaSemColunaLegivel só tem id (number) e codigo (int, não string)
    // Então não tem coluna string — cai no fallback de ID
    const warnSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {})
    const resultado = resolverDisplayField(tabelaSemColunaLegivel, "tabela_sem_legivel")
    expect(resultado.displayField).toBe("id")
    expect(resultado.fallbackId).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("tabela_sem_legivel"),
    )
    warnSpy.mockRestore()
  })

  it("fallback para ID com warning quando tabela não tem coluna legível", () => {
    const warnSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {})
    const fk = inferirFk(tabelaComFkSemLegivel, tabelaComFkSemLegivel.refId)
    expect(fk?.displayField).toBe("id")
    expect(fk?.fallbackId).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("retorna undefined para coluna sem FK", () => {
    const fk = inferirFk(unidades, unidades.label)
    expect(fk).toBeUndefined()
  })
})

describe("gerarFields com inferência de FK", () => {
  const todasTabelas = {
    condominios,
    unidades,
    tarefas,
    subtarefas,
  }

  it("campo FK sem annotation vira multipleChoice com resource/displayField inferidos", () => {
    const fields = gerarFields(unidades, "unidades", {}, todasTabelas)
    const condominioId = fields.find((f) => f.name === "condominio_id")
    expect(condominioId).toBeDefined()
    expect(condominioId?.type).toBe("multipleChoice")
    expect(condominioId?.multipleChoice).toEqual({
      resource: "condominios",
      idField: "id",
      displayField: "nome",
    })
  })

  it("annotation com type explícito vence a inferência de FK", () => {
    const fields = gerarFields(
      unidades,
      "unidades",
      { condominio_id: { type: "text" } },
      todasTabelas,
    )
    const condominioId = fields.find((f) => f.name === "condominio_id")
    expect(condominioId?.type).toBe("text")
    expect(condominioId?.multipleChoice).toBeUndefined()
  })

  it("sem tabelas, campo FK não é inferido (backward-compat)", () => {
    const fields = gerarFields(unidades, "unidades", {})
    const condominioId = fields.find((f) => f.name === "condominio_id")
    expect(condominioId?.type).toBe("number")
    expect(condominioId?.multipleChoice).toBeUndefined()
  })

  it("campo não-FK não é afetado pela inferência", () => {
    const fields = gerarFields(unidades, "unidades", {}, todasTabelas)
    const label = fields.find((f) => f.name === "label")
    expect(label?.type).toBe("text")
    expect(label?.multipleChoice).toBeUndefined()
  })
})
