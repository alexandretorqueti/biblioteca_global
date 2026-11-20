/**
 * Schema do projeto `voz-na-isa` — PROVISÓRIO de setup (bootstrap mínimo).
 *
 * ⚠️ PROVISÓRIO — será substituído quando houver plano aprovado
 * (especificacaoCrud do plano macro; ver docs/ESPECIFICACAO.md). Não há plano
 * aprovado: este bootstrap contém uma única tabela de metadados de voz para
 * materializar o `schema.ts` obrigatório ao registro dinâmico da plataforma
 * (DynamicSchemaRegistry) e às migrations do banco `projeto_8498`. O modelo de
 * dados DEFINITIVO (mensagens de voz, configuração de síntese/transcrição,
 * telemetria de uso sem áudio — RF-15) será materializado a partir da
 * `especificacaoCrud` do plano aprovado e substituirá este bootstrap.
 *
 * Decisão de produto registrada em docs/ESPECIFICACAO.md: nenhum áudio é
 * persistido (TTS ou microfone) — a tabela guarda apenas metadados textuais de
 * leitura em voz alta.
 *
 * Tabela:
 * - voz_configuracoes: parâmetros de voz por escopo (uma linha por escopo).
 */
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
import {
  bigint,
  boolean,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core"

// ============================================================================
// VOZ CONFIGURAÇÕES (bootstrap — substituir pelo modelo do plano aprovado)
// ============================================================================

export const vozConfiguracoes = mysqlTable(
  "voz_configuracoes",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Escopo da configuração (ex.: "padrao", tenant do Atendente-MT). */
    escopo: varchar("escopo", { length: 100 }).notNull(),
    /** Voz de síntese (Fase 1: voz feminina pt-BR "Isadora" via phonon/ollama). */
    voz: varchar("voz", { length: 100 }).notNull().default("isadora"),
    /** Idioma BCP-47 da síntese/transcrição (padrão pt-BR). */
    idioma: varchar("idioma", { length: 10 }).notNull().default("pt-BR"),
    /** Chave de feature flag da camada de voz para o escopo. */
    ativa: boolean("ativa").notNull().default(false),
    /** Observações textuais do operador (sem áudio — RF-15). */
    observacoes: text("observacoes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (tabela) => [unique("voz_configuracoes_escopo_unico").on(tabela.escopo)],
)

/** Anotações de formulário — labels legíveis para o GeradorSistema. */
export const annotations: FormAnnotationsPorTabela = {
  voz_configuracoes: {
    escopo: { label: "Escopo", maxLength: 100 },
    voz: { label: "Voz", maxLength: 100 },
    idioma: { label: "Idioma", maxLength: 10 },
    ativa: { label: "Ativa" },
    observacoes: { label: "Observações", type: "textarea", fullWidth: true },
  },
}
