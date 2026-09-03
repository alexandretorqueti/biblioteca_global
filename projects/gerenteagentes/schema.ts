/**
 * Schema do projeto `gerenteagentes` — gerenciamento de agentes de IA.
 *
 * Tabelas:
 * - Captação (Isa): contatos, projetos_captados, definicoes, chats, chat_mensagens
 * - Execução (motor): tarefas, subtarefas, tarefa_chats, projeto_chats,
 *   geracoes_projeto, bloqueios
 * - Agentes: ids dos agentes mantidos pelo OpenClaw (1:1 com projetos_captados)
 *
 * Relações:
 * - projeto → agente OpenClaw (1:1, agenteId único)
 * - projeto → definições (1:N)
 * - projeto → tarefas (1:N; agente e ambiente de execução vêm do projeto)
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
import { taskStatusesHelperText, subtaskStatusesHelperText } from "./motor-v2/src/shared/task-statuses"

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

/** Agentes do OpenClaw (espelho local — fonte de verdade é o console). */
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
  branchTrabalho: varchar("branch_trabalho", { length: 255 }),
  repoPath: varchar("repo_path", { length: 500 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/** Cadeia operacional de modelos por projeto e fase do motor. */
export const projetoModelChain = mysqlTable("projeto_model_chain", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  fase: varchar("fase", { length: 30 }).notNull(),
  modelo: varchar("modelo", { length: 150 }).notNull(),
  posicao: int("posicao").notNull(),
  ativo: boolean("ativo").notNull().default(true),
  isLocal: boolean("is_local").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

/** Configuração operacional explícita usada pelo Motor-v2. */
export const projetoMotorConfig = mysqlTable("projeto_motor_config", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" })
    .unique(),
  repoPath: varchar("repo_path", { length: 500 }).notNull(),
  branchTrabalho: varchar("branch_trabalho", { length: 255 }).notNull(),
  buildCommand: varchar("build_command", { length: 500 }).notNull(),
  unitTestCommand: varchar("unit_test_command", { length: 500 }).notNull(),
  unitTestExclude: json("unit_test_exclude"),
  defaultMaxRework: int("default_max_rework").notNull().default(3),
  defaultHardTimeoutMs: bigint("default_hard_timeout_ms", { mode: "number" }).notNull().default(3600000),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

export const definicoes = mysqlTable("definicoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  // Durante a captação (antes do fechamento) a definição fica vinculada ao
  // chat (buffer); após o fechamento é vinculada ao projetos_captados criado.
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  chatId: bigint("chat_id", { mode: "number", unsigned: true })
    .references(() => chats.id, { onDelete: "cascade" }),
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
  // Nome do projeto aprovado pelo cliente durante a captação (sugerido pela Isa).
  nomeProjeto: varchar("nome_projeto", { length: 200 }),
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

/** Registro de visitas ao site (anonimizado — IP como hash SHA-256). */
export const visitasSite = mysqlTable("visitas_site", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  visitorKey: varchar("visitor_key", { length: 255 }), // identificador anônimo do navegador
  pageUrl: varchar("page_url", { length: 4000 }),
  referrer: varchar("referrer", { length: 4000 }),
  userAgent: varchar("user_agent", { length: 2000 }),
  ipHash: varchar("ip_hash", { length: 64 }), // SHA-256 do IP (nunca IP em claro)
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/** Verificação de email do onboarding (código de 6 dígitos, HMAC-SHA256). */
export const emailVerifications = mysqlTable("email_verifications", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  chatId: bigint("chat_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 200 }).notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(), // HMAC-SHA256(code, secret + email)
  expiresAt: timestamp("expires_at").notNull(),
  attempts: int("attempts").notNull().default(0),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// EXECUÇÃO (Motor)
// ============================================================================

export const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  externalId: varchar("external_id", { length: 64 }).unique(),
  projetoId: bigint("projeto_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => projetosCaptados.id, { onDelete: "cascade" }),
  // Agente e ambiente de execução (repoPath/buildCommand/unitTestCommand)
  // vivem em projetos_captados — o motor resolve via projeto.
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
  // Última mensagem de erro da execução — separada da descrição para que
  // falhas não sobrescrevam o texto original da tarefa (lacuna do saveTask).
  ultimaMensagemErro: text("ultima_mensagem_erro"),
  status: varchar("status", { length: 50 }).notNull().default("draft"), // Ver motor-v2/src/shared/task-statuses.ts para lista completa
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
  // Encadeamento: subtarefa depende de outra subtarefa da mesma tarefa.
  // FK self-reference criada na migration (0002_brief_sue_storm) — mesmo
  // padrão de tarefas.depends_on_task_id (drizzle exige anotação p/ self-ref).
  dependsOnSubtaskId: bigint("depends_on_subtask_id", {
    mode: "number",
    unsigned: true,
  }),
  resultado: text("resultado"),
  correctionForSubtaskId: bigint("correction_for_subtask_id", { mode: "number", unsigned: true }),
  correctionFingerprint: varchar("correction_fingerprint", { length: 500 }),
  correctionCreatedAt: timestamp("correction_created_at"),
  // Metadados do worktree exclusivo (migration 0011). Permanecem até a
  // integração e limpeza recuperável para permitir auditoria/retomada.
  workspacePath: varchar("workspace_path", { length: 1000 }),
  workspaceBranch: varchar("workspace_branch", { length: 255 }),
  workspaceBaseCommit: varchar("workspace_base_commit", { length: 64 }),
  workspaceCommitSha: varchar("workspace_commit_sha", { length: 64 }),
  workspaceStatus: varchar("workspace_status", { length: 32 }),
  workspaceCreatedAt: timestamp("workspace_created_at"),
  workspaceCleanedAt: timestamp("workspace_cleaned_at"),
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
  status: varchar("status", { length: 50 }).notNull().default("pending"), // pending, running, completed, failed, awaiting_clarification
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

// ============================================================================
// PARALELISMO (Motor v2)
// ============================================================================

export const executionResources = mysqlTable("execution_resources", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  resourceKey: varchar("resource_key", { length: 200 }).notNull().unique(),
  executionId: varchar("execution_id", { length: 200 }).notNull(),
  ownerId: varchar("owner_id", { length: 200 }).notNull(),
  fencingToken: int("fencing_token").notNull().default(1),
  heartbeatAt: timestamp("heartbeat_at").notNull(),
  acquiredAt: timestamp("acquired_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const executionResourceQueue = mysqlTable("execution_resource_queue", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  resourceKey: varchar("resource_key", { length: 200 }).notNull(),
  executionId: varchar("execution_id", { length: 200 }).notNull(),
  taskId: varchar("task_id", { length: 200 }).notNull(),
  priority: int("priority").notNull().default(0),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  status: varchar("status", { length: 20 }).notNull().default("waiting"),
})

// ============================================================================
// BLOQUEIOS (Motor v1 - legado)
// ============================================================================

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
  agentes: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    modelo: { label: "Modelo", maxLength: 100 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    ativo: { label: "Ativo" },
  },
  projetos_captados: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    slug: { label: "Slug", maxLength: 100 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    regras: { label: "Regras", type: "textarea", fullWidth: true },
    contato_id: { label: "Contato" },
    agente_id: { label: "Agente" },
    ativo: { label: "Ativo" },
    plataforma_projeto_id: { label: "Projeto Plataforma" },
    branch_trabalho: { label: "Branch de Trabalho", maxLength: 255 },
    repo_path: { label: "Caminho do repositório", maxLength: 500 },
  },
  projeto_motor_config: {
    projeto_id: { label: "Projeto" },
    repo_path: { label: "Caminho do repositório", fullWidth: true, maxLength: 500 },
    branch_trabalho: { label: "Branch de trabalho", maxLength: 255 },
    build_command: { label: "Comando de build", fullWidth: true, maxLength: 500 },
    unit_test_command: { label: "Comando de testes", fullWidth: true, maxLength: 500 },
    unit_test_exclude: { label: "Exclusões de testes", type: "textarea", fullWidth: true },
    default_max_rework: { label: "Máx. de retrabalho padrão" },
    default_hard_timeout_ms: { label: "Timeout padrão (ms)" },
  },
  definicoes: {
    projeto_id: { label: "Projeto" },
    texto: { label: "Definição", type: "textarea", fullWidth: true },
    seq: { label: "Ordem" },
  },
  chats: {
    contato_id: { label: "Contato" },
    projeto_id: { label: "Projeto" },
    status: { label: "Status", helperText: "aberto | em_andamento | finalizado" },
  },
  chat_mensagens: {
    chat_id: { label: "Chat" },
    role: { label: "Role", helperText: "user | assistant | system" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  visitas_site: {
    visitor_key: { label: "Visitante", maxLength: 255 },
    page_url: { label: "Página", maxLength: 4000 },
    referrer: { label: "Referer", maxLength: 4000 },
    user_agent: { label: "User-Agent", maxLength: 2000 },
    ip_hash: { label: "IP (hash)", maxLength: 64 },
  },
  email_verifications: {
    chat_id: { label: "Chat" },
    email: { label: "Email", maxLength: 200 },
    code_hash: { label: "Código (hash)", maxLength: 64 },
    expires_at: { label: "Expira em" },
    attempts: { label: "Tentativas" },
    used: { label: "Usado" },
  },
  tarefas: {
    projeto_id: { label: "Projeto" },
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    status: {
      label: "Status",
      helperText: taskStatusesHelperText(),
    },
    max_rework: { label: "Máx. Retrabalho" },
    hard_timeout_ms: { label: "Timeout (ms)" },
    depends_on_task_id: { label: "Depende de" },
    auto_start: { label: "Início Automático" },
    boot_retry_count: { label: "Tentativas de Boot" },
  },
  subtarefas: {
    tarefa_id: { label: "Tarefa" },
    seq: { label: "Sequência" },
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    status: {
      label: "Status",
      helperText: subtaskStatusesHelperText(),
    },
    depends_on_subtask_id: { label: "Depende de" },
    resultado: { label: "Resultado", type: "textarea", fullWidth: true },
    duracao_segundos: { label: "Duração (s)" },
    iniciada_em: { label: "Iniciada em" },
    finalizada_em: { label: "Finalizada em" },
  },
  tarefa_chats: {
    tarefa_id: { label: "Tarefa" },
    role: { label: "Role", helperText: "user | assistant | system | analyst" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  projeto_chats: {
    projeto_id: { label: "Projeto" },
    role: { label: "Role", helperText: "user | assistant | system | analyst" },
    texto: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  geracoesProjeto: {
    projeto_id: { label: "Projeto" },
    status: { label: "Status", helperText: "pending | running | completed | failed" },
    session_key: { label: "Session Key", maxLength: 200 },
    modelo: { label: "Modelo", maxLength: 100 },
    briefing: { label: "Briefing", type: "textarea", fullWidth: true },
    erro: { label: "Erro", type: "textarea", fullWidth: true },
  },
  bloqueios: {
    tarefa_id: { label: "Tarefa" },
    block_reason: { label: "Razão", type: "textarea", fullWidth: true },
    block_command: { label: "Comando", type: "textarea", fullWidth: true },
    block_exit_code: { label: "Exit Code" },
    block_excerpt: { label: "Excerto", type: "textarea", fullWidth: true },
    blocked_at: { label: "Bloqueado em" },
  },
} satisfies FormAnnotationsPorTabela
