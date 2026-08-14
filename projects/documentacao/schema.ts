/**
 * Schema do projeto `documentacao` — fonte da verdade do modelo de negócio
 * deste projeto (PoC §3/§7.2). Migrations em ./migrations/.
 *
 * Etapa 5: tabela `componentes` dá suporte ao CRUD genérico e à futura
 * documentação viva (Etapa 10).
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
