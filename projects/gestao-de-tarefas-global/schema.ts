/**
 * Schema do projeto `gestao-de-tarefas-global` — fonte única de verdade
 * (migrations, validação Zod e config JSON derivam daqui).
 *
 * Modelo de dados conforme docs/ESPEC-CRUD.md (plano macro #1, 2026-11-04):
 * 11 tabelas — organizacoes, areas, tags, colaboradores, tarefas,
 * tarefa_tags, mensagens_tarefa, anexos, regras_recorrencia,
 * historico_tarefas, notificacoes.
 *
 * PROJETO ÚNICO (clarificação 1): não há projeto por organização; todas as
 * tabelas de negócio têm organizacaoId e a filtragem row-level por
 * organização do usuário logado é escopo custom (fora deste schema).
 *
 * Fora de escopo (subtarefas/módulos próprios): tenancy row-level, máquina
 * de estados, motores de recorrência/lembrete e upload de arquivos.
 */
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  time,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core"

// ============================================================================
// ORGANIZAÇÕES (Administração → Organizações, roleFilter admin)
// ============================================================================

export const organizacoes = mysqlTable("organizacoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 160 }).notNull(),
  descricao: text("descricao"),
  ativa: boolean("ativa").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

// ============================================================================
// COLABORADORES (Administração → Colaboradores, roleFilter admin|gerente)
// ============================================================================

export const colaboradores = mysqlTable("colaboradores", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => organizacoes.id),
  nome: varchar("nome", { length: 160 }).notNull(),
  email: varchar("email", { length: 160 }).notNull(),
  telefone: varchar("telefone", { length: 20 }),
  /**
   * CPF com máscara (000.000.000-00 → 14 chars). Dado SENSÍVEL (LGPD):
   * visível apenas para admin/gerente (hiddenColumns na config + bloqueio
   * no backend — fluxo custom).
   */
  cpf: char("cpf", { length: 14 }),
  ativo: boolean("ativo").notNull().default(true),
  /**
   * Vínculo com o usuário global da plataforma (core.usuarios). Sem FK
   * física: banco do projeto (projeto_<id>) é isolado do core.
   */
  usuarioId: int("usuario_id", { unsigned: true }),
})

// ============================================================================
// ÁREAS (Cadastros → Áreas)
// ============================================================================

export const areas = mysqlTable(
  "areas",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => organizacoes.id),
    nome: varchar("nome", { length: 120 }).notNull(),
    descricao: text("descricao"),
    /** Líder da área — cadastrável como responsável (FK → colaboradores). */
    responsavelId: bigint("responsavel_id", {
      mode: "number",
      unsigned: true,
    }).references(() => colaboradores.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [unique("areas_organizacao_id_nome_unique").on(table.organizacaoId, table.nome)],
)

// ============================================================================
// TAGS (Cadastros → Tags)
// ============================================================================

export const tags = mysqlTable(
  "tags",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => organizacoes.id),
    nome: varchar("nome", { length: 80 }).notNull(),
  },
  (table) => [unique("tags_organizacao_id_nome_unique").on(table.organizacaoId, table.nome)],
)

// ============================================================================
// REGRAS DE RECORRÊNCIA (Tarefas → Recorrências)
// ============================================================================

export const regrasRecorrencia = mysqlTable("regras_recorrencia", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => organizacoes.id),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
  areaId: bigint("area_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => areas.id),
  responsavelId: bigint("responsavel_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => colaboradores.id),
  frequencia: mysqlEnum("frequencia", ["diaria", "semanal", "mensal"]).notNull(),
  /** Dias da semana (obrigatório p/ semanal — validado no motor de recorrência). */
  diasSemana: json("dias_semana"),
  horaDoDia: time("hora_do_dia"),
  dataInicio: date("data_inicio").notNull(),
  /** NULL = sem fim. Quando presente: minDate ≥ dataInicio (validação de form). */
  dataFim: date("data_fim"),
  ativa: boolean("ativa").notNull().default(true),
  /** Próxima geração calculada pelo motor de recorrência (fora deste escopo). */
  proximaGeracao: datetime("proxima_geracao"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

// ============================================================================
// TAREFAS (Tarefas → Todas as tarefas; children: chat, histórico, anexos)
// ============================================================================

export const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => organizacoes.id),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
  areaId: bigint("area_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => areas.id),
  /** Responsável único ativo da tarefa. */
  responsavelId: bigint("responsavel_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => colaboradores.id),
  criadoPorId: bigint("criado_por_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => colaboradores.id),
  prioridade: mysqlEnum("prioridade", ["baixa", "media", "alta", "urgente"])
    .notNull()
    .default("media"),
  prazo: datetime("prazo"),
  /** Editável apenas via endpoints do fluxo custom (máquina de estados — fora deste escopo). */
  status: mysqlEnum("status", [
    "aberta",
    "delegada",
    "concluida",
    "precisa_informacoes",
    "aguardando_terceiro",
    "cancelada",
  ])
    .notNull()
    .default("aberta"),
  /** NULL = sem aviso. Proibido não-nulo quando prazo é NULL (validação de domínio). */
  lembreteAntecedenciaMinutos: int("lembrete_antecedencia_minutos"),
  regraRecorrenciaId: bigint("regra_recorrencia_id", {
    mode: "number",
    unsigned: true,
  }).references(() => regrasRecorrencia.id),
  concluidaEm: datetime("concluida_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

// ============================================================================
// TAREFA_TAGS (pivot sem tela; tags via multipleChoice multiple na tarefa)
// ============================================================================

export const tarefaTags = mysqlTable(
  "tarefa_tags",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tarefas.id, { onDelete: "cascade" }),
    tagId: bigint("tag_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [unique("tarefa_tags_tarefa_id_tag_id_unique").on(table.tarefaId, table.tagId)],
)

// ============================================================================
// MENSAGENS_TAREFA (chat da tarefa; UI reaproveita TaskChat nativo)
// ============================================================================

export const mensagensTarefa = mysqlTable("mensagens_tarefa", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id),
  autorId: bigint("autor_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => colaboradores.id),
  texto: text("texto").notNull(),
  criadoEm: timestamp("criado_em").notNull().defaultNow(),
})

// ============================================================================
// ANEXOS (childScreen de tarefas via fluxo custom de anexos)
// ============================================================================

export const anexos = mysqlTable("anexos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => organizacoes.id),
  nomeArquivo: varchar("nome_arquivo", { length: 255 }).notNull(),
  mimeType: varchar("mime_type", { length: 120 }),
  tamanhoBytes: bigint("tamanho_bytes", { mode: "number", unsigned: true }),
  /** Chave de armazenamento do arquivo (upload é módulo custom — fora deste escopo). */
  chaveArmazenamento: varchar("chave_armazenamento", { length: 500 }).notNull(),
  enviadoPorId: bigint("enviado_por_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => colaboradores.id),
  criadoEm: timestamp("criado_em").notNull().defaultNow(),
})

// ============================================================================
// HISTORICO_TAREFAS (childScreen de tarefas: Histórico; append-only)
// ============================================================================

export const historicoTarefas = mysqlTable("historico_tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => tarefas.id),
  tipoEvento: mysqlEnum("tipo_evento", [
    "criacao",
    "delegacao",
    "devolucao_concluida",
    "devolucao_precisa_info",
    "devolucao_aguardando_terceiro",
    "reatribuicao",
    "mudanca_status",
    "mudanca_prazo",
    "mudanca_prioridade",
    "anexo",
    "lembrete_gerado",
  ]).notNull(),
  deColaboradorId: bigint("de_colaborador_id", {
    mode: "number",
    unsigned: true,
  }).references(() => colaboradores.id),
  paraColaboradorId: bigint("para_colaborador_id", {
    mode: "number",
    unsigned: true,
  }).references(() => colaboradores.id),
  mensagem: text("mensagem"),
  criadoEm: timestamp("criado_em").notNull().defaultNow(),
})

// ============================================================================
// NOTIFICACOES (consumidas pelo sino custom; sem tela de cadastro)
// ============================================================================

export const notificacoes = mysqlTable("notificacoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => organizacoes.id),
  /** Usuário global da plataforma (core.usuarios) — sem FK física (bancos isolados). */
  usuarioId: int("usuario_id", { unsigned: true }).notNull(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  corpo: text("corpo"),
  tipo: mysqlEnum("tipo", ["lembrete", "delegacao", "devolucao", "sistema"]).notNull(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).references(
    () => tarefas.id,
  ),
  lida: boolean("lida").notNull().default(false),
  criadoEm: timestamp("criado_em").notNull().defaultNow(),
})

// ============================================================================
// ANNOTATIONS DE FORMULÁRIO (PoC §7.2 — consumidas por coletarAnnotations)
// ============================================================================

export const annotations = {
  organizacoes: {
    nome: { label: "Nome", required: true, minLength: 2, fullWidth: true },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
  },
  areas: {
    nome: { label: "Nome", required: true, fullWidth: true },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
  },
  tags: {
    nome: { label: "Nome", required: true },
  },
  colaboradores: {
    nome: { label: "Nome completo", required: true, validator: "nomeCompleto", fullWidth: true },
    email: { label: "E-mail", type: "email", required: true, fullWidth: true },
    telefone: { label: "Telefone", mask: "telefone", validator: "telefone" },
    cpf: { label: "CPF", mask: "cpf", validator: "cpf", sensitive: true },
  },
  tarefas: {
    titulo: { label: "Título", required: true, minLength: 3, fullWidth: true },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
  },
  mensagens_tarefa: {
    texto: { label: "Mensagem", type: "textarea", required: true, fullWidth: true },
  },
  regras_recorrencia: {
    titulo: { label: "Título", required: true, fullWidth: true },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    dataInicio: { label: "Data de início", required: true },
  },
} satisfies FormAnnotationsPorTabela
