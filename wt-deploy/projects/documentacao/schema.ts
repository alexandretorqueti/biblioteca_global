/**
 * Schema do projeto `documentacao` — fonte da verdade do modelo de negócio
 * deste projeto (PoC §3/§7.2). Migrations em ./migrations/.
 *
 * O mapa `annotations` alimenta o gerador de fields (Etapa 6) — convenção
 * do projeto para metadata de formulário (risco §12.3 do PoC).
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

export const componentes = mysqlTable("componentes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 150 }).notNull().unique(),
  categoria: varchar("categoria", { length: 100 }).notNull(),
  descricao: text("descricao"),
  ordem: int("ordem").notNull().default(0),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/** Metadata de formulário por tabela/coluna — lida pelo gerador de config. */
export const annotations = {
  componentes: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    categoria: { label: "Categoria" },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    ordem: { label: "Ordem", helperText: "Ordenação no catálogo" },
    ativo: { label: "Ativo" },
  },
} satisfies FormAnnotationsPorTabela
