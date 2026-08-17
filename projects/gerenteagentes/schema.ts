/**
 * Schema do projeto `gerenteagentes` — piloto para gerenciamento de
 * agentes de IA (PoC §7.2). Tabelas: agentes + tarefas + execucoes.
 *
 * Master-detail: `execucoes.tarefaId` referencia `tarefas.id` (uma tarefa
 * tem N execuções). O vínculo de tela filha (children/fkField) vive na
 * config JSON, não no schema — aqui fica apenas a FK real no banco.
 */
import {
  bigint,
  boolean,
  int,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"

export const agentes = mysqlTable("agentes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 150 }).notNull().unique(),
  modelo: varchar("modelo", { length: 100 }).notNull(),
  descricao: text("descricao"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  agenteId: bigint("agente_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => agentes.id, { onDelete: "cascade" }),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
  status: varchar("status", { length: 50 }).notNull().default("pendente"),
  prioridade: int("prioridade").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/**
 * Execuções de uma tarefa (filha de `tarefas` — master-detail).
 * A FK `tarefaId` é o campo de ligação usado pela tela filha da config.
 */
export const execucoes = mysqlTable("execucoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 50 }).notNull().default("pendente"),
  resultado: text("resultado"),
  duracaoSegundos: int("duracao_segundos"),
  iniciadaEm: timestamp("iniciada_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/** Metadata de formulário por tabela/coluna. */
export const annotations = {
  agentes: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    modelo: { label: "Modelo" },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    ativo: { label: "Ativo" },
  },
  tarefas: {
    agenteId: { label: "Agente (ID)" },
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    status: { label: "Status", helperText: "pendente | em_andamento | concluida | cancelada" },
    prioridade: { label: "Prioridade" },
  },
  execucoes: {
    tarefaId: { label: "Tarefa (ID)" },
    status: { label: "Status", helperText: "pendente | em_andamento | concluida | cancelada" },
    resultado: { label: "Resultado", type: "textarea", fullWidth: true },
    duracaoSegundos: { label: "Duração (s)" },
    iniciadaEm: { label: "Iniciada em" },
  },
} satisfies FormAnnotationsPorTabela
