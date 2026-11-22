/**
 * Schema do projeto `calculadora-de-investimentos-gabriel` — fonte única de
 * verdade (migrations, validação Zod e config JSON derivam daqui).
 *
 * Modelo de dados derivado de docs/ESPECIFICACAO.md (entidade
 * "Índice: nome, taxa atual (anual e mensal derivada), fonte da cotação")
 * e do padrão `projects/voz-na-isa`. A fonte declarada na macro,
 * docs/ESPEC-CRUD.md, não existe no repositório nem em worktree — decisão
 * registrada em docs/DECISOES-SUBTAREFA-2.md (plano macro #6, posição 1/9).
 *
 * Tabela:
 * - indices: índices de mercado selecionáveis na calculadora (REQ-F-001).
 *   A taxa mensal NÃO é coluna — é derivada da anual por juros compostos
 *   (REQ-F-006: apenas a mensal alimenta a projeção; calcular, não guardar).
 *   A cotação automática (SGS/BrasilAPI) atualiza `taxa_anual` em subtarefa
 *   própria, fora deste escopo.
 */
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
import {
  bigint,
  decimal,
  int,
  mysqlTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core"

// ============================================================================
// ÍNDICES (cadastro Índices — CDI, Selic, IPCA, Ibovespa; seed ordem 1–4)
// ============================================================================

export const indices = mysqlTable(
  "indices",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Nome por extenso exibido na lista selecionável (RF-3). */
    nome: varchar("nome", { length: 100 }).notNull(),
    /** Sigla usada na escolha rápida e na integração de cotação (ex.: CDI). */
    sigla: varchar("sigla", { length: 20 }).notNull(),
    /**
     * Taxa anual vigente em % a.a. com 4 casas (ex.: 10,8500). A mensal é
     * derivada (RF-6) — `(1+anual)^(1/12)-1` — e nunca persistida.
     */
    taxaAnual: decimal("taxa_anual", { precision: 9, scale: 4 })
      .notNull()
      .default("0"),
    /** Origem da cotação vigente (ex.: "Banco Central (SGS)"; RF-3/Integrações). */
    fonteCotacao: varchar("fonte_cotacao", { length: 100 }).notNull().default("Banco Central (SGS)"),
    /** Ordenação estável na lista de índices (seed: CDI 1, Selic 2, IPCA 3, Ibovespa 4). */
    ordem: int("ordem").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (tabela) => [
    unique("indices_nome_unico").on(tabela.nome),
    unique("indices_sigla_unica").on(tabela.sigla),
  ],
)

/** Anotações de formulário — labels legíveis para o GeradorSistema. */
export const annotations: FormAnnotationsPorTabela = {
  indices: {
    nome: { label: "Nome", maxLength: 100, required: true },
    sigla: { label: "Sigla", maxLength: 20, required: true },
    taxaAnual: {
      label: "Taxa anual (% a.a.)",
      type: "number",
      min: 0,
      helperText: "Taxa anual vigente; a mensal é derivada automaticamente",
    },
    fonteCotacao: { label: "Fonte da cotação", maxLength: 100 },
    ordem: { label: "Ordem", helperText: "Ordenação na lista de índices" },
  },
}
