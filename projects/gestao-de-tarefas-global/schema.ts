import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
import {
  bigint,
  boolean,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"

export const areas = mysqlTable("areas", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  nome: varchar("nome", { length: 150 }).notNull().unique(),
  descricao: text("descricao"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

export const tags = mysqlTable("tags", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  nome: varchar("nome", { length: 100 }).notNull().unique(),
  cor: varchar("cor", { length: 20 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * Configuração única do sistema. Linha única (id = 1): o timezone IANA é a
 * referência para todos os cálculos de recorrência e prazos — nunca o
 * timezone local do servidor. Validação de IANA no contrato de domínio
 * (src/recorrencias.ts).
 */
export const configuracaoSistema = mysqlTable("configuracao_sistema", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

/**
 * Regra de recorrência. Parâmetros de calendário estruturados permitem
 * calcular a próxima ocorrência sem depender do timezone local do servidor:
 * horaExecucao/diasSemana/diaMes/mes são interpretados no timezone único do
 * sistema (configuracao_sistema).
 */
export const recorrencias = mysqlTable("recorrencias", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  descricao: varchar("descricao", { length: 200 }).notNull(),
  frequencia: mysqlEnum("frequencia", ["diaria", "semanal", "mensal", "anual"]).notNull(),
  /** Horário de execução "HH:MM" no timezone do sistema. */
  horaExecucao: varchar("hora_execucao", { length: 5 }).notNull().default("09:00"),
  /** Semanal: dias ISO (1=segunda..7=domingo) em CSV — aceita múltiplos dias. */
  diasSemana: varchar("dias_semana", { length: 20 }),
  /** Mensal/anual: dia do mês (1-31). */
  diaMes: smallint("dia_mes"),
  /** Anual: mês (1-12). */
  mes: smallint("mes"),
  /** @deprecated regra livre legada; mantida nula para compatibilidade — substituída pelos parâmetros estruturados. */
  regra: varchar("regra", { length: 200 }),
  proximaExecucao: timestamp("proxima_execucao"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
})

export const tarefas = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  areaId: bigint("area_id", { mode: "number", unsigned: true }).notNull().references(() => areas.id, { onDelete: "restrict" }),
  recorrenciaId: bigint("recorrencia_id", { mode: "number", unsigned: true }).references(() => recorrencias.id, { onDelete: "set null" }),
  criadoPorId: bigint("criado_por_id", { mode: "number", unsigned: true }).notNull(),
  titulo: varchar("titulo", { length: 240 }).notNull(),
  descricao: text("descricao"),
  status: mysqlEnum("status", ["aberta", "em_andamento", "aguardando", "concluida", "cancelada"]).notNull().default("aberta"),
  prioridade: mysqlEnum("prioridade", ["baixa", "normal", "alta", "urgente"]).notNull().default("normal"),
  prazo: timestamp("prazo"),
  concluidaEm: timestamp("concluida_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [index("tarefas_area_idx").on(table.areaId), index("tarefas_status_prazo_idx").on(table.status, table.prazo)])

/**
 * Ocorrência programada de uma recorrência. Registra a relação
 * tarefa-base ↔ recorrência ↔ instância gerada e possui identidade
 * determinística (`chave`, única) para impedir duplicação em reprocessamentos.
 * `ocorrenciaEm` é o instante UTC da ocorrência; o horário local é derivado
 * do timezone do sistema.
 */
export const ocorrenciasRecorrencias = mysqlTable("ocorrencias_recorrencias", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  recorrenciaId: bigint("recorrencia_id", { mode: "number", unsigned: true }).notNull().references(() => recorrencias.id, { onDelete: "cascade" }),
  /** Tarefa-base que originou a recorrência (preservada mesmo após gerada a instância). */
  tarefaBaseId: bigint("tarefa_base_id", { mode: "number", unsigned: true }).references(() => tarefas.id, { onDelete: "set null" }),
  /** Instância de tarefa gerada para esta ocorrência, quando gerada. */
  tarefaGeradaId: bigint("tarefa_gerada_id", { mode: "number", unsigned: true }).references(() => tarefas.id, { onDelete: "set null" }),
  ocorrenciaEm: timestamp("ocorrencia_em").notNull(),
  /** Identidade determinística da ocorrência (rec-<recorrenciaId>-<instante UTC>). */
  chave: varchar("chave", { length: 160 }).notNull().unique(),
  status: mysqlEnum("status", ["programada", "gerada", "cancelada"]).notNull().default("programada"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [index("ocorrencias_recorrencia_idx").on(table.recorrenciaId), index("ocorrencias_pendentes_idx").on(table.status, table.ocorrenciaEm)])

export const tarefasTags = mysqlTable("tarefas_tags", {
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  tagId: bigint("tag_id", { mode: "number", unsigned: true }).notNull().references(() => tags.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.tarefaId, table.tagId] })])

export const atribuicoes = mysqlTable("atribuicoes", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  responsavelId: bigint("responsavel_id", { mode: "number", unsigned: true }).notNull(),
  atribuidoPorId: bigint("atribuido_por_id", { mode: "number", unsigned: true }).notNull(),
  resposta: mysqlEnum("resposta", ["pendente", "concluida", "mais_informacoes", "aguardando_outra_pessoa"]).notNull().default("pendente"),
  observacoes: text("observacoes"),
  iniciadoEm: timestamp("iniciado_em"),
  respondidoEm: timestamp("respondido_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [index("atribuicoes_tarefa_idx").on(table.tarefaId), index("atribuicoes_responsavel_idx").on(table.responsavelId)])

export const comentarios = mysqlTable("comentarios", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  autorId: bigint("autor_id", { mode: "number", unsigned: true }).notNull(),
  conteudo: text("conteudo").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [index("comentarios_tarefa_idx").on(table.tarefaId)])

export const anexos = mysqlTable("anexos", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  enviadoPorId: bigint("enviado_por_id", { mode: "number", unsigned: true }).notNull(),
  nome: varchar("nome", { length: 255 }).notNull(),
  tipo: varchar("tipo", { length: 120 }).notNull(),
  url: varchar("url", { length: 1000 }).notNull(),
  tamanhoBytes: bigint("tamanho_bytes", { mode: "number", unsigned: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [index("anexos_tarefa_idx").on(table.tarefaId)])

export const historicoTarefas = mysqlTable("historico_tarefas", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  autorId: bigint("autor_id", { mode: "number", unsigned: true }).notNull(),
  evento: varchar("evento", { length: 100 }).notNull(),
  detalhes: text("detalhes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [index("historico_tarefas_tarefa_idx").on(table.tarefaId)])

export const lembretes = mysqlTable("lembretes", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  tarefaId: bigint("tarefa_id", { mode: "number", unsigned: true }).notNull().references(() => tarefas.id, { onDelete: "cascade" }),
  usuarioId: bigint("usuario_id", { mode: "number", unsigned: true }).notNull(),
  canal: mysqlEnum("canal", ["site", "email"]).notNull(),
  notificarEm: timestamp("notificar_em").notNull(),
  enviadoEm: timestamp("enviado_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [index("lembretes_pendentes_idx").on(table.notificarEm, table.enviadoEm)])

export const annotations = {
  areas: { nome: { label: "Nome", fullWidth: true, maxLength: 150 }, descricao: { label: "Descrição", type: "textarea", fullWidth: true } },
  tags: { nome: { label: "Nome", maxLength: 100 }, cor: { label: "Cor", maxLength: 20 } },
  tarefas: { titulo: { label: "Título", fullWidth: true, maxLength: 240 }, descricao: { label: "Descrição", type: "textarea", fullWidth: true } },
  recorrencias: {
    descricao: { label: "Descrição", fullWidth: true, maxLength: 200 },
    horaExecucao: { label: "Horário de execução (HH:MM)", maxLength: 5 },
    diasSemana: { label: "Dias da semana (1=seg..7=dom, separados por vírgula)", maxLength: 20 },
    diaMes: { label: "Dia do mês (1-31)" },
    mes: { label: "Mês (1-12)" },
  },
  configuracao_sistema: { timezone: { label: "Timezone do sistema (IANA)", maxLength: 64 } },
} satisfies FormAnnotationsPorTabela
