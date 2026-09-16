/**
 * Schema Drizzle do Motor-v3 — catálogo event-driven
 *
 * Reflete as tabelas definidas na ESPECIFICACAO.md §15.
 * As tabelas existentes (tarefas, subtarefas, bloqueios, etc.) continuam
 * fora deste schema e são acessadas via queries diretas (DrizzleDb legado
 * ou SQL puro no repositório).
 */

import { mysqlTable, int, varchar, text, json, timestamp, tinyint, mysqlEnum } from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'

// ============================================================
// motor_events — o que pode acontecer
// ============================================================
export const motorEvents = mysqlTable('motor_events', {
  id: int('id').primaryKey().autoincrement(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  category: mysqlEnum('category', ['erro', 'verificacao', 'conclusao', 'estado', 'humano', 'infra']).notNull(),
  scope: mysqlEnum('scope', ['global', 'projeto', 'tarefa', 'subtarefa']).notNull().default('subtarefa'),
  priority: int('priority').notNull().default(100),
  active: tinyint('active').notNull().default(1),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_patterns — regex/string para detectar eventos
// ============================================================
export const motorPatterns = mysqlTable('motor_patterns', {
  id: int('id').primaryKey().autoincrement(),
  eventId: int('event_id').notNull().references(() => motorEvents.id, { onDelete: 'cascade' }),
  pattern: text('pattern').notNull(),
  matchType: mysqlEnum('match_type', ['regex', 'contains', 'exact']).notNull().default('contains'),
  matchTarget: mysqlEnum('match_target', ['code', 'message', 'stack', 'action_result']).notNull().default('message'),
  active: tinyint('active').notNull().default(1),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_primitives — operações atômicas (código fixo)
// Tabela de referência; registro real em código.
// ============================================================
export const motorPrimitives = mysqlTable('motor_primitives', {
  id: int('id').primaryKey().autoincrement(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  domain: mysqlEnum('domain', ['session', 'model', 'git', 'db', 'queue', 'control']).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_actions — composição de primitivas (configurável via banco)
// ============================================================
export const motorActions: any = mysqlTable('motor_actions', {
  id: int('id').primaryKey().autoincrement(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  primitivesJson: json('primitives_json').$type<Array<{ primitive: string; params?: Record<string, any> }>>().notNull(),
  onPartialFailure: mysqlEnum('on_partial_failure', ['continue', 'compensate', 'mark_dirty']).notNull().default('continue'),
  compensationActionId: int('compensation_action_id').references(() => motorActions.id, { onDelete: 'set null' }),
  isTerminal: tinyint('is_terminal').notNull().default(0),
  active: tinyint('active').notNull().default(1),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_reactions — cadeia progressiva por evento (1x → 2x → 3x → ...)
// ============================================================
export const motorReactions = mysqlTable('motor_reactions', {
  id: int('id').primaryKey().autoincrement(),
  eventId: int('event_id').notNull().references(() => motorEvents.id, { onDelete: 'cascade' }),
  occurrence: int('occurrence').notNull(),
  actionId: int('action_id').notNull().references(() => motorActions.id, { onDelete: 'cascade' }),
  paramsJson: json('params_json').$type<Record<string, any>>(),
  active: tinyint('active').notNull().default(1),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_occurrences — contagem ativa por evento/tarefa/subtarefa/geração (B13)
// ============================================================
export const motorOccurrences = mysqlTable('motor_occurrences', {
  id: int('id').primaryKey().autoincrement(),
  eventId: int('event_id').notNull().references(() => motorEvents.id, { onDelete: 'cascade' }),
  tarefaId: varchar('tarefa_id', { length: 100 }).notNull(),
  subtarefaId: int('subtarefa_id'),
  generation: int('generation').notNull().default(1),
  count: int('count').notNull().default(1),
  lastOccurredAt: timestamp('last_occurred_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_promotion_state — compensação B20 (dirty flag)
// ============================================================
export const motorPromotionState = mysqlTable('motor_promotion_state', {
  id: int('id').primaryKey().autoincrement(),
  tarefaId: varchar('tarefa_id', { length: 100 }).notNull().unique(),
  dirty: tinyint('dirty').notNull().default(0),
  conflictFilesJson: json('conflict_files_json').$type<string[]>(),
  attempts: int('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_catalog_proposals — aprendizado do Monitor (B01)
// ============================================================
export const motorCatalogProposals = mysqlTable('motor_catalog_proposals', {
  id: int('id').primaryKey().autoincrement(),
  source: mysqlEnum('source', ['monitor', 'human']).notNull(),
  status: mysqlEnum('status', ['auto_activated', 'pending_review', 'approved', 'rejected']).notNull().default('pending_review'),
  eventId: int('event_id').references(() => motorEvents.id),
  diagnosis: text('diagnosis').notNull(),
  proposalJson: json('proposal_json').$type<Record<string, any>>().notNull(),
  tarefaId: varchar('tarefa_id', { length: 100 }).notNull(),
  subtarefaId: int('subtarefa_id'),
  reviewedBy: varchar('reviewed_by', { length: 100 }),
  reviewNotes: text('review_notes'),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_event_log — observabilidade (log estruturado de cada evento)
// ============================================================
export const motorEventLog = mysqlTable('motor_event_log', {
  id: int('id').primaryKey().autoincrement(),
  direction: mysqlEnum('direction', ['sent', 'received', 'event', 'action']).notNull(),
  messageType: varchar('message_type', { length: 200 }).notNull(),
  tarefaId: varchar('tarefa_id', { length: 100 }),
  subtarefaId: int('subtarefa_id'),
  model: varchar('model', { length: 200 }),
  generation: int('generation'),
  correlationId: varchar('correlation_id', { length: 200 }),
  payloadJson: json('payload_json').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

// ============================================================
// motor_model_cooldown — herdada do v2 (cooldown global de modelos)
// ============================================================
export const motorModelCooldown = mysqlTable('motor_model_cooldown', {
  id: int('id').primaryKey().autoincrement(),
  model: varchar('model', { length: 200 }).notNull(),
  reason: varchar('reason', { length: 100 }).notNull(),
  until: timestamp('until').notNull(),
  occurrences: int('occurrences').notNull().default(1),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
})
