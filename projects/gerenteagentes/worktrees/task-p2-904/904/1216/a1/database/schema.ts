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
  int,
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
  /** Campo legado; novos fluxos devem usar cpfCriptografado. */
  cpf: varchar("cpf", { length: 14 }).unique(),
  /** CPF protegido com AES-256-GCM (IV e tag fazem parte do ciphertext). */
  cpfCriptografado: varchar("cpf_criptografado", { length: 255 }),
  /** argon2id — nunca logar nem retornar (PoC §11).
   * Nullable: contas provisionadas sem senha entram por código (auth única). */
  passwordHash: varchar("password_hash", { length: 255 }),
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
  /** Branch de trabalho do projeto (ex.: base-desenvolvimento). */
  branchTrabalho: varchar("branch_trabalho", { length: 255 }),
  /** Caminho do repositório do projeto no host. */
  repoPath: varchar("repo_path", { length: 500 }),
  /** ID do agente vinculado ao projeto (ex.: biblioteca-global). */
  agenteId: varchar("agente_id", { length: 100 }),
  // ── Conexão MySQL customizada por projeto (opcional) ────────────────
  // Quando todos vazios, a ProjectDbFactory usa as credenciais do env.
  // Quando preenchidos, o projeto usa um banco MySQL externo (DbaaS, etc.).
  /** Host do MySQL customizado (ex.: dbaas.example.com). */
  dbHost: varchar("db_host", { length: 255 }),
  /** Porta do MySQL customizado (padrão 3306 quando não informado). */
  dbPort: int("db_port"),
  /** Nome do database no MySQL customizado. */
  dbDatabase: varchar("db_database", { length: 255 }),
  /** Usuário do MySQL customizado. */
  dbUser: varchar("db_user", { length: 255 }),
  /** Senha criptografada (AES-256-GCM) do MySQL customizado — NUNCA logar/retornar. */
  dbPasswordCriptografado: varchar("db_password_criptografado", { length: 512 }),
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

export const emailVerifications = mysqlTable(
  "email_verifications",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Chave de busca — um e-mail pode ter várias linhas (cada pedido gera uma nova). */
    email: varchar("email", { length: 255 }).notNull(),
    /** HMAC-SHA256 do código de 6 dígitos — NUNCA o código em claro (D5). */
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    attempts: int("attempts").notNull().default(0),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_email_verifications_email").on(t.email)],
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

/** Consentimentos da política de privacidade por usuário e versão. */
export const consentimentos = mysqlTable(
  "consentimentos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    data: timestamp("data").notNull().defaultNow(),
    versaoPolitica: varchar("versao_politica", { length: 50 }).notNull(),
    ip: varchar("ip", { length: 45 }),
  },
  (t) => [index("idx_consentimentos_usuario").on(t.usuarioId)],
)

/** Auditoria de acesso a dados pessoais sensíveis. */
export const logsAcessoDadosSensiveis = mysqlTable(
  "logs_acesso_dados_sensiveis",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tipoDado: varchar("tipo_dado", { length: 50 }).notNull(),
    acao: varchar("acao", { length: 50 }).notNull(),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
    ip: varchar("ip", { length: 45 }),
  },
  (t) => [index("idx_logs_acesso_dados_sensiveis_usuario").on(t.usuarioId)],
)

/** Sessões do HelpDesk iniciadas por um usuário em um projeto. */
export const helpdeskSessoes = mysqlTable(
  "helpdesk_sessoes",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => projetos.id, { onDelete: "cascade" }),
    agenteId: varchar("agente_id", { length: 100 }).notNull(),
    status: mysqlEnum("status", ["active", "closed"]).notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_helpdesk_sessoes_usuario").on(t.usuarioId),
    index("idx_helpdesk_sessoes_projeto").on(t.projetoId),
  ],
)

/** Mensagens persistidas de uma sessão do HelpDesk. */
export const helpdeskMensagens = mysqlTable(
  "helpdesk_mensagens",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    sessaoId: bigint("sessao_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => helpdeskSessoes.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["agent", "user", "system"]).notNull(),
    text: varchar("text", { length: 10000 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_helpdesk_mensagens_sessao").on(t.sessaoId)],
)
