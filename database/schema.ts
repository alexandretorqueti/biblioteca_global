/**
 * Schema Drizzle do database `core` — fonte única das tabelas sistêmicas
 * (PoC §4.2). Migrations SQL versionadas em database/migrations/.
 *
 * Regras:
 * - Identificadores (username/email/telefone/cpf) são opcionais e UNIQUE —
 *   MySQL 8 aceita múltiplos NULL em UNIQUE (PoC §4.2, regra de identificador).
 * - `config` de projetos guarda a config CORRENTE do GeradorSistema (JSON).
 * - Vínculo usuário↔projeto é N:N com perfil POR PROJETO.
 */
import {
  bigint,
  boolean,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const PERFIS = [
  "admin",
  "gerente",
  "operador",
  "visualizador",
] as const

export const usuarios = mysqlTable("usuarios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  username: varchar("username", { length: 100 }).unique(),
  email: varchar("email", { length: 255 }).unique(),
  telefone: varchar("telefone", { length: 30 }).unique(),
  cpf: varchar("cpf", { length: 14 }).unique(),
  /** argon2id — nunca logar nem retornar (PoC §11). */
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  nome: varchar("nome", { length: 150 }).notNull(),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const projetos = mysqlTable("projetos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 150 }).notNull(),
  /** Identifica a pasta projects/<slug>/ e rotas — o database é projeto_<id>. */
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  ativo: boolean("ativo").notNull().default(true),
  /** Config corrente do GeradorSistema (iniciada igual à base versionada). */
  config: json("config").$type<GeradorSistemaConfig>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const projetosUsuarios = mysqlTable(
  "projetos_usuarios",
  {
    projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => projetos.id),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => usuarios.id),
    /** Perfil do usuário DENTRO daquele projeto. */
    perfil: mysqlEnum("perfil", PERFIS).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projetoId, t.usuarioId] })],
)

export const refreshTokens = mysqlTable(
  "refresh_tokens",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** Hash do refresh token (global, sem escopo de projeto) — revogável. */
    tokenHash: varchar("token_hash", { length: 255 }).notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_refresh_tokens_usuario").on(t.usuarioId)],
)
