/**
 * Schema do projeto `gerenteagentes` — gerenciamento de agentes de IA.
 *
 * Tabelas:
 * - Captação (Isa): contatos, projetos_captados, definicoes, chats, chat_mensagens
 * - Execução (motor): tarefas, subtarefas, tarefa_chats, projeto_chats,
 *   geracoes_projeto, bloqueios
 * - Agentes: agentes (1:1 com projetos_captados)
 *
 * Relações:
 * - projeto → agente (1:1, agenteId único)
 * - projeto → definições (1:N)
 * - projeto → tarefas (1:N)
 * - tarefa → subtarefas (1:N)
 * - tarefa → tarefa_chats (1:N)
 * - projeto → projeto_chats (1:N)
 * - projeto → geracoes_projeto (1:N, histórico de gerações)
 */
import {
  bigint,
  boolean,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"

// ============================================================================
// AGENTES (declarado primeiro — sem dependências)
// ============================================================================

//TODO: Adicionar o campo do ID do agente do openclaw (usando a mesma estratégia do projeto Console Openclaw)
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

// ============================================================================
// CAPTAÇÃO (Isa)
// ============================================================================

export const contatos = mysqlTable("contatos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 150 }),
  email: varchar("email", { length: 200 }).notNull(),
  telefone: varchar("telefone", { length: 50 }),
  origem: varchar("origem", { length: 100 }), // site, whatsapp, etc.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const projetosCaptados = mysqlTable("projetos_captados", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  descricao: text("descricao"),
  regras: text("regras"), // regras do projeto
  contatoId: bigint("contato_id", { mode: "number", unsigned: true })
    .references(() => contatos.id, { onDelete: "set null" }),
  agenteId: bigint("agente_id", { mode: "number", unsigned: true })
    .references(() => agentes.id, { onDelete: "set null" }),
  ativo: boolean("ativo").notNull().default(true),
  // Vínculo 1:1 com app da plataforma (preenchido ao iniciar desenvolvimento)
  plataformaProjetoId: bigint("plataforma_projeto_id", {
    mode: "number",
    unsigned: true,
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const definicoes = mysqlTable("definicoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  texto: text("texto").notNull(),
  seq: int("seq").notNull().default(0), // ordem da definição
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const chats = mysqlTable("chats", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  contatoId: bigint("contato_id", { mode: "number", unsigned: true })
    .references(() => contatos.id, { onDelete: "set null" }),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .references(() => projetosCaptados.id, { onDelete: "set null" }),
  status: varchar("status", { length: 50 }).notNull().default("aberto"), // aberto, em_andamento, finalizado
  // Identidade do visitante (migração Postgres→MySQL, MIGRACAO_MYSQL_PENDENCIAS §3.2/§4.2):
  chatKey: varchar("chat_key", { length: 200 }), // chave estável do navegador (pré-onboarding)
  sessionKey: varchar("session_key", { length: 200 }), // sessão do agente no OpenClaw (ponte)
  visitorName: varchar("visitor_name", { length: 150 }), // onboarding anônimo
  pendingEmail: varchar("pending_email", { length: 200 }), // email pendente de verificação
  // Regra "1 chat por email": fusão de chats do mesmo contato.
  // FK self-referente criada na migration (chats.merged_into → chats.id).
  mergedInto: bigint("merged_into", { mode: "number", unsigned: true }),
  // Handoff pós-criação: personalidade e desenvolvimento (marcas idempotentes).
  handoffs: json("handoffs"), // ex.: { personality: { at, sessionKey }, development: { at, sessionKey } }
  sessionKeys: json("session_keys"), // chaves de sessão por etapa (ex.: { personality, development })
  // Email/nome definitivos (usados por setChatEmail/mergeChatInto no motor).
  email: varchar("email", { length: 200 }),
  name: varchar("name", { length: 150 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const chatMensagens = mysqlTable("chat_mensagens", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  chatId: bigint("chat_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(), // user, assistant, system
  texto: text("texto").notNull(),
  // Metadados de anexos (nome/tamanho) — o binário fica em storage separado.
  attachments: json("attachments"),
  typing: boolean("typing").notNull().default(false), // flag de digitação
  seq: int("seq"), // ordem estável de chegada
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// EXECUÇÃO (Motor)
// ============================================================================

export const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  agenteId: bigint("agente_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => agentes.id, { onDelete: "cascade" }),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
  repoPath: text("repo_path"), // caminho do repo no host
  buildCommand: varchar("build_command", { length: 500 }),
  unitTestCommand: varchar("unit_test_command", { length: 500 }),
  status: varchar("status", { length: 50 }).notNull().default("draft"), // draft, planned, running, paused, completed, failed, cancelled
  maxRework: int("max_rework").notNull().default(3),
  hardTimeoutMs: bigint("hard_timeout_ms", { mode: "number" }),
  dependsOnTaskId: bigint("depends_on_task_id", { mode: "number", unsigned: true }),
  // FK self-reference criada na migration (tarefas.depends_on_task_id → tarefas.id)
  autoStart: boolean("auto_start").notNull().default(false),
  bootRetryCount: int("boot_retry_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const subtarefas = mysqlTable("subtarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id, { onDelete: "cascade" }),
  seq: int("seq").notNull(), // ordem da subtarefa
  titulo: varchar("titulo", { length: 200 }).notNull(),
  // Escopo e critérios de aceite da subtarefa (migração Postgres→MySQL §3.2/§4.7).
  scope: text("scope"), // escopo da subtarefa
  acceptanceCriteria: json("acceptance_criteria"), // critérios de aceite (lista)
  descricao: text("descricao"),
  status: varchar("status", { length: 50 }).notNull().default("pending"), // pending, running, verified, failed
  // Contador de entregas (uma entrega por vez).
  deliverCount: int("deliver_count").notNull().default(0),
  resultado: text("resultado"),
  duracaoSegundos: int("duracao_segundos"),
  iniciadaEm: timestamp("iniciada_em"),
  finalizadaEm: timestamp("finalizada_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const tarefaChats = mysqlTable("tarefa_chats", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(), // user, assistant, system, analyst
  texto: text("texto").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const projetoChats = mysqlTable("projeto_chats", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(), // user, assistant, system, analyst
  texto: text("texto").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const geracoesProjeto = mysqlTable("geracoes_projeto", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 50 }).notNull().default("pending"), // pending, running, completed, failed
  sessionKey: varchar("session_key", { length: 200 }),
  modelo: varchar("modelo", { length: 100 }),
  briefing: text("briefing"),
  // IDs/títulos das tarefas macro geradas nesta geração (migração §4.12).
  tasks: json("tasks"),
  erro: text("erro"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const bloqueios = mysqlTable("bloqueios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id, { onDelete: "cascade" }),
  // Bloqueio por subtarefa (migração §4.13): opcional quando o bloqueio é da tarefa.
  subtarefaId: bigint("subtarefa_id", { mode: "number", unsigned: true })
    .references(() => subtarefas.id, { onDelete: "cascade" }),
  blockReason: text("block_reason"),
  blockCommand: text("block_command"),
  blockExitCode: int("block_exit_code"),
  blockExcerpt: text("block_excerpt"),
  blockedAt: timestamp("blocked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// ANNOTATIONS (metadata de formulário)
// ============================================================================

export const annotations = {
  contatos: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    email: { label: "Email", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 50 },
    origem: { label: "Origem", maxLength: 100 },
  },
  projetos_captados: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    slug: { label: "Slug", maxLength: 100 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    regras: { label: "Regras", type: "textarea", fullWidth: true },
    contato_id: { label: "Contato (ID)" },
    agente_id: { label: "Agente (ID)" },
    ativo: { label: "Ativo" },
    plataforma_projeto_id: { label: "Projeto Plataforma (ID)" },
  },
  definicoes: {
    projeto_id: { label: "Projeto (ID)" },
    texto: { label: "Definição", type: "textarea", fullWidth: true },
    seq: { label: "Ordem" },
  },
  chats: {
    contato_id: { label: "Contato (ID)" },
    projeto_id: { label: "Projeto (ID)" },
    status: { label: "Status", helperText: "aberto | em_andamento | finalizado" },
  },
  chat_mensagens: {
    chat_id: { label: "Chat (ID)" },
    role: { label: "Role", helperText: "user | assistant | system" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  tarefas: {
    projeto_id: { label: "Projeto (ID)" },
    agente_id: { label: "Agente (ID)" },
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    repo_path: { label: "Repo Path", fullWidth: true },
    build_command: { label: "Build Command", maxLength: 500 },
    unit_test_command: { label: "Test Command", maxLength: 500 },
    status: {
      label: "Status",
      helperText: "draft | planned | running | paused | completed | failed | cancelled",
    },
    max_rework: { label: "Max Retrabalho" },
    hard_timeout_ms: { label: "Timeout (ms)" },
    depends_on_task_id: { label: "Depende de (ID)" },
    auto_start: { label: "Auto Start" },
    boot_retry_count: { label: "Retry Count" },
  },
  subtarefas: {
    tarefa_id: { label: "Tarefa (ID)" },
    seq: { label: "Sequência" },
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    status: {
      label: "Status",
      helperText: "pending | running | verified | failed",
    },
    resultado: { label: "Resultado", type: "textarea", fullWidth: true },
    duracao_segundos: { label: "Duração (s)" },
    iniciada_em: { label: "Iniciada em" },
    finalizada_em: { label: "Finalizada em" },
  },
  tarefa_chats: {
    tarefa_id: { label: "Tarefa (ID)" },
    role: { label: "Role", helperText: "user | assistant | system | analyst" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  projeto_chats: {
    projeto_id: { label: "Projeto (ID)" },
    role: { label: "Role", helperText: "user | assistant | system | analyst" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  geracoesProjeto: {
    projeto_id: { label: "Projeto (ID)" },
    status: { label: "Status", helperText: "pending | running | completed | failed" },
    session_key: { label: "Session Key", maxLength: 200 },
    modelo: { label: "Modelo", maxLength: 100 },
    briefing: { label: "Briefing", type: "textarea", fullWidth: true },
    erro: { label: "Erro", type: "textarea", fullWidth: true },
  },
  bloqueios: {
    tarefa_id: { label: "Tarefa (ID)" },
    block_reason: { label: "Razão", type: "textarea", fullWidth: true },
    block_command: { label: "Comando", type: "textarea", fullWidth: true },
    block_exit_code: { label: "Exit Code" },
    block_excerpt: { label: "Excerto", type: "textarea", fullWidth: true },
    blocked_at: { label: "Bloqueado em" },
  },
  agentes: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    modelo: { label: "Modelo" },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    ativo: { label: "Ativo" },
  },
} satisfies FormAnnotationsPorTabela
