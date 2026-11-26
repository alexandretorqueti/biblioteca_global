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
  char,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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

export const TENANT_STATUS = ["ativo", "suspenso", "onboarding"] as const
export const TENANT_PLANOS = ["starter", "pro", "enterprise"] as const

/** Configuração e metadados privados de um cliente do chat universal. */
export const tenants = mysqlTable("tenants", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  nome: varchar("nome", { length: 150 }).notNull(),
  dominio: varchar("dominio", { length: 255 }).unique(),
  status: mysqlEnum("status", TENANT_STATUS).notNull().default("onboarding"),
  plano: mysqlEnum("plano", TENANT_PLANOS).notNull().default("starter"),
  /** Configuração editável; somente uma projeção validada é pública. */
  configJson: json("config_json").notNull(),
  /** Referência interna da persona, nunca exposta pelo contrato público. */
  personaRef: varchar("persona_ref", { length: 255 }),
  /** Contatos operacionais internos, não fazem parte do runtime público. */
  contatos: json("contatos"),
  /** Referência ao cofre de segredos, nunca o segredo em si. */
  segredosRef: varchar("segredos_ref", { length: 255 }),
  /** Retenção privada de conversas para LGPD; não faz parte do config público. */
  retencaoConversasDias: int("retencao_conversas_dias", { unsigned: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

export const TENANT_CANAL_WHATSAPP_ESTADOS = [
  "pareando",
  "ativo",
  "expirado",
  "removido",
] as const

/** Vínculo entre a conta WhatsApp do gateway e um tenant da Biblioteca. */
export const tenantCanaisWhatsapp = mysqlTable(
  "tenant_canais_whatsapp",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Identificador canônico do account no OpenClaw: slug do tenant. */
    accountId: varchar("account_id", { length: 100 }).notNull().unique(),
    numero: varchar("numero", { length: 20 }),
    agentId: varchar("agent_id", { length: 255 }),
    estado: mysqlEnum("estado", TENANT_CANAL_WHATSAPP_ESTADOS)
      .notNull()
      .default("pareando"),
    ultimoStatusEm: timestamp("ultimo_status_em"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [index("idx_tenant_canais_whatsapp_tenant_id").on(t.tenantId)],
)

/** Ferramentas do catálogo habilitadas para um tenant. */
export const tenantTools = mysqlTable(
  "tenant_tools",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    toolKey: varchar("tool_key", { length: 100 }).notNull(),
    paramsJson: json("params_json"),
    ativo: boolean("ativo").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_tenant_tools_tenant_id").on(t.tenantId),
    uniqueIndex("uq_tenant_tools_tenant_tool").on(t.tenantId, t.toolKey),
  ],
)

/** Conversas persistidas para o painel administrativo do tenant. */
export const tenantConversas = mysqlTable(
  "tenant_conversas",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    canal: mysqlEnum("canal", ["web", "whatsapp"]).notNull(),
    visitanteKey: varchar("visitante_key", { length: 255 }).notNull(),
    contatoNome: varchar("contato_nome", { length: 255 }),
    contatoEmail: varchar("contato_email", { length: 320 }),
    tema: varchar("tema", { length: 255 }),
    status: mysqlEnum("status", ["ativa", "finalizada", "transbordada"]).notNull(),
    primeiraMensagemEm: timestamp("primeira_mensagem_em").notNull(),
    ultimaMensagemEm: timestamp("ultima_mensagem_em").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    index("idx_tenant_conversas_tenant_id").on(t.tenantId),
    index("idx_tenant_conversas_tenant_ultima").on(t.tenantId, t.ultimaMensagemEm),
    index("idx_tenant_conversas_tenant_created").on(t.tenantId, t.createdAt),
    uniqueIndex("uq_tenant_conversas_tenant_external").on(t.tenantId, t.externalId),
  ],
)

export const tenantConversaMensagens = mysqlTable(
  "tenant_conversa_mensagens",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    conversaId: bigint("conversa_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenantConversas.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["visitante", "agente", "sistema"]).notNull(),
    texto: text("texto").notNull(),
    criadaEm: timestamp("criada_em").notNull(),
  },
  (t) => [index("idx_tenant_conversa_mensagens_conversa_criada").on(t.conversaId, t.criadaEm)],
)

export const tenantLeads = mysqlTable(
  "tenant_leads",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversaId: bigint("conversa_id", { mode: "number", unsigned: true }).references(
      () => tenantConversas.id,
      { onDelete: "set null" },
    ),
    ferramenta: varchar("ferramenta", { length: 100 }).notNull(),
    dadosJson: json("dados_json").notNull(),
    externalId: varchar("external_id", { length: 255 }),
    criadoEm: timestamp("criado_em").notNull().defaultNow(),
  },
  (t) => [
    index("idx_tenant_leads_tenant_id").on(t.tenantId),
    uniqueIndex("uq_tenant_leads_tenant_external").on(t.tenantId, t.externalId),
  ],
)

export const tenantCotaAlertas = mysqlTable(
  "tenant_cota_alertas",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mesCompetencia: char("mes_competencia", { length: 7 }).notNull(),
    enviadoEm: timestamp("enviado_em").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_tenant_cota_alertas_tenant_mes").on(t.tenantId, t.mesCompetencia),
  ],
)

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

/** Auditoria dos logins bem-sucedidos (senha ou código enviado por e-mail). */
export const logsLogin = mysqlTable(
  "logs_login",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    usuarioId: bigint("usuario_id", { mode: "number", unsigned: true }).references(
      () => usuarios.id,
      { onDelete: "set null" },
    ),
    email: varchar("email", { length: 255 }).notNull(),
    metodo: mysqlEnum("metodo", ["senha", "codigo_email"]).notNull(),
    codigo: varchar("codigo", { length: 10 }),
    ip: varchar("ip", { length: 45 }),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (t) => [
    index("idx_logs_login_timestamp").on(t.timestamp),
    index("idx_logs_login_usuario_id").on(t.usuarioId),
  ],
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
    ultimoConsoleMessageId: varchar("ultimo_console_message_id", { length: 191 }),
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

/** Planos comerciais do produto de atendentes IA. */
export const planosProduto = mysqlTable("planos_produto", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  nome: varchar("nome", { length: 150 }).notNull(),
  precoCentavos: int("preco_centavos", { unsigned: true }).notNull(),
  moeda: varchar("moeda", { length: 3 }).notNull().default("BRL"),
  ciclo: mysqlEnum("ciclo", ["monthly", "yearly"]).notNull(),
  limitesCotas: json("limites_cotas").notNull(),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/** Assinaturas dos tenants no PSP escolhido pelo fluxo de billing. */
export const assinaturas = mysqlTable(
  "assinaturas",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Reservado para a FK de tenants, a ser adicionada no follow-up isas-mt-01. */
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true }),
    /** Referência provisória até a tabela tenants existir no core. */
    tenantSlug: varchar("tenant_slug", { length: 64 }).notNull(),
    planoProdutoId: bigint("plano_produto_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => planosProduto.id),
    status: mysqlEnum("status", [
      "pending",
      "active",
      "past_due",
      "canceled",
      "expired",
      "reembolsavel",
    ])
      .notNull()
      .default("pending"),
    ciclo: mysqlEnum("ciclo", ["monthly", "yearly"]).notNull(),
    pspCustomerId: varchar("psp_customer_id", { length: 255 }),
    pspSubscriptionId: varchar("psp_subscription_id", { length: 255 }).unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_assinaturas_tenant_id").on(t.tenantId),
    index("idx_assinaturas_tenant_slug").on(t.tenantSlug),
    index("idx_assinaturas_status").on(t.status),
  ],
)

/** Inbox durável de eventos recebidos do PSP, com deduplicação e retry. */
export const billingWebhookEvents = mysqlTable(
  "billing_webhook_events",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    dedupeKey: varchar("dedupe_key", { length: 512 }).notNull().unique(),
    tipo: varchar("tipo", { length: 100 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["pending", "processing", "done", "failed", "dead"])
      .notNull()
      .default("pending"),
    tentativas: int("tentativas", { unsigned: true }).notNull().default(0),
    proximaTentativaEm: timestamp("proxima_tentativa_em"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_billing_webhook_events_status_retry").on(
      t.status,
      t.proximaTentativaEm,
    ),
  ],
)

/** Outbox durável das ações de provisionamento decorrentes de uma assinatura. */
export const provisionamentoPendente = mysqlTable(
  "provisionamento_pendente",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    assinaturaId: bigint("assinatura_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => assinaturas.id),
    tipo: varchar("tipo", { length: 100 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["pending", "processing", "done", "failed", "dead"])
      .notNull()
      .default("pending"),
    tentativas: int("tentativas", { unsigned: true }).notNull().default(0),
    ciclo: varchar("ciclo", { length: 100 }).notNull(),
    proximaTentativaEm: timestamp("proxima_tentativa_em"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_provisionamento_pendente_status_retry").on(
      t.status,
      t.proximaTentativaEm,
    ),
    uniqueIndex("uq_provisionamento_pendente_assinatura_tipo_ciclo").on(
      t.assinaturaId,
      t.tipo,
      t.ciclo,
    ),
  ],
)

/** Configuração de transbordo humano por tenant/projeto. */
export const transbordoConfig = mysqlTable(
  "transbordo_config",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    tenantSlug: varchar("tenant_slug", { length: 100 }).notNull().unique(),
    ativo: boolean("ativo").notNull().default(false),
    destinoTipo: mysqlEnum("destino_tipo", ["email", "telegram", "whatsapp"]).notNull(),
    destinoValor: varchar("destino_valor", { length: 320 }).notNull(),
    atendenteNome: varchar("atendente_nome", { length: 150 }).notNull(),
    horario: json("horario").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
)

/** Ciclo de vida e auditoria de cada transbordo de uma sessão HelpDesk. */
export const transbordos = mysqlTable(
  "transbordos",
  {
    id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
    tenantSlug: varchar("tenant_slug", { length: 100 }).notNull(),
    sessaoId: bigint("sessao_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => helpdeskSessoes.id, { onDelete: "cascade" }),
    estado: mysqlEnum("estado", ["pending", "active", "released", "expired", "cancelled"])
      .notNull()
      .default("pending"),
    notificacaoEstado: mysqlEnum("notificacao_estado", ["pending", "sent", "failed"])
      .notNull()
      .default("pending"),
    notificacaoTentadaEm: timestamp("notificacao_tentada_em"),
    notificacaoEnviadaEm: timestamp("notificacao_enviada_em"),
    notificacaoErro: varchar("notificacao_erro", { length: 1000 }),
    tokenLiberacaoHash: varchar("token_liberacao_hash", { length: 128 }).notNull().unique(),
    tokenLiberacaoExpiraEm: timestamp("token_liberacao_expira_em").notNull(),
    tokenLiberacaoUsadoEm: timestamp("token_liberacao_usado_em"),
    liberadoEm: timestamp("liberado_em"),
    liberadoPor: varchar("liberado_por", { length: 150 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    index("idx_transbordos_tenant_slug").on(t.tenantSlug),
    index("idx_transbordos_sessao_id").on(t.sessaoId),
    index("idx_transbordos_estado").on(t.estado),
  ],
)

/**
 * Personas geradas pelo Forjador por API (isas-mt-04) — versionamento no core.
 * Vínculo PROVISÓRIO por tenant_slug/tenant_id SEM FK para tenants (a tabela de
 * isas-mt-01 ainda não existe); espelha a convenção de `assinaturas.tenant_id`.
 * `correlation_id` é a chave de idempotência/retomada do forjamento.
 */
export const personasForjadas = mysqlTable(
  "personas_forjadas",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Referência provisória até a tabela tenants existir no core. */
    tenantSlug: varchar("tenant_slug", { length: 64 }),
    /** Reservado para a FK de tenants, a ser adicionada no follow-up isas-mt-01. */
    tenantId: bigint("tenant_id", { mode: "number", unsigned: true }),
    descricaoNegocio: text("descricao_negocio").notNull(),
    /** SHA-256 (hex) do material enviado — auditoria/repetibilidade. */
    materialHash: char("material_hash", { length: 64 }),
    /** Chave de idempotência/retomada em caso de timeout. */
    correlationId: varchar("correlation_id", { length: 100 }),
    /** Textos da persona — nulos enquanto `pending`. */
    soulMd: longtext("soul_md"),
    identityMd: longtext("identity_md"),
    agentsMd: longtext("agents_md"),
    versao: int("versao", { unsigned: true }).notNull(),
    /** Session key da sessão do Forjador (waitForSessionIdle). */
    sessionKey: varchar("session_key", { length: 200 }),
    status: mysqlEnum("status", ["pending", "completed", "failed", "timeout"])
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    // MySQL permite múltiplos NULL em UNIQUE — personas sem slug versionam livremente.
    uniqueIndex("uq_personas_forjadas_tenant_slug_versao").on(t.tenantSlug, t.versao),
    index("idx_personas_forjadas_tenant_slug").on(t.tenantSlug),
    index("idx_personas_forjadas_correlation_id").on(t.correlationId),
  ],
)

/** Lead do funil self-service, identificado pela conversa da Isa. */
export const negocios = mysqlTable(
  "negocios",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    chatId: varchar("chat_id", { length: 255 }).notNull().unique(),
    nome: varchar("nome", { length: 255 }).notNull(),
    segmentoDescricao: varchar("segmento_descricao", { length: 2000 }).notNull(),
    contato: json("contato").notNull(),
    transbordo: json("transbordo").notNull(),
    status: mysqlEnum("status", [
      "capturado",
      "aguardando_plano",
      "checkout",
      "pago",
      "provisionando",
      "provisionado",
      "falho",
    ]).notNull().default("capturado"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
)

/** Arquivos recebidos no funil; a indexação/RAG é deliberadamente posterior. */
export const negocioDocumentos = mysqlTable(
  "negocio_documentos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    negocioId: bigint("negocio_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => negocios.id, { onDelete: "cascade" }),
    nome: varchar("nome", { length: 255 }).notNull(),
    mime: varchar("mime", { length: 100 }).notNull(),
    tamanho: int("tamanho", { unsigned: true }).notNull(),
    caminho: varchar("caminho", { length: 1000 }).notNull(),
    usoDiferido: boolean("uso_diferido").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_negocio_documentos_negocio").on(t.negocioId)],
)

/** Pedido captura o estado completo do negócio para o orquestrador pós-pagamento. */
export const pedidosVenda = mysqlTable(
  "pedidos_venda",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    negocioId: bigint("negocio_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => negocios.id),
    planoSlug: varchar("plano_slug", { length: 100 }).notNull(),
    checkoutUrl: varchar("checkout_url", { length: 2000 }),
    assinaturaId: bigint("assinatura_id", { mode: "number", unsigned: true }).references(
      () => assinaturas.id,
      { onDelete: "set null" },
    ),
    payloadSnapshot: json("payload_snapshot").notNull(),
    status: mysqlEnum("status", ["pending", "paid", "aguardando_aceite", "provisioning", "provisioned", "failed", "refunded"])
      .notNull()
      .default("pending"),
    welcomeEmailSent: boolean("welcome_email_sent").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => [
    index("idx_pedidos_venda_negocio").on(t.negocioId),
    index("idx_pedidos_venda_assinatura").on(t.assinaturaId),
  ],
)
