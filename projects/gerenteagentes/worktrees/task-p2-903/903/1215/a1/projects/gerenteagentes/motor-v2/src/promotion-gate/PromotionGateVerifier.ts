/**
 * Verificador puro da promoção. Não cria subtarefas, não executa Git e não
 * altera o banco: recebe o estado já coletado e devolve achados auditáveis.
 */
export type PromotionGateIssueKind = "migration_journal" | "schema_contract"

export interface PromotionGateIssue {
  kind: PromotionGateIssueKind
  fingerprint: string
  message: string
  evidence: string
}

export interface MigrationFile {
  path: string
  content: string
}

export interface SchemaColumnRequirement {
  table: string
  column: string
  /** Caminho/trecho do código que passa a depender da coluna. */
  source: string
}

export interface PromotionGateInput {
  migrations: readonly MigrationFile[]
  journalContent: string
  requiredColumns: readonly SchemaColumnRequirement[]
}

export interface PromotionGateReport {
  ok: boolean
  issues: PromotionGateIssue[]
}

interface JournalEntry { tag?: unknown }

function normalized(value: string): string {
  return value.toLowerCase().replace(/`/g, "").replace(/\s+/g, " ")
}

function migrationTag(path: string): string | null {
  const name = path.split("/").at(-1) ?? ""
  return /^(\d+_[a-z0-9_]+)\.sql$/i.exec(name)?.[1] ?? null
}

function hasColumn(sql: string, requirement: SchemaColumnRequirement): boolean {
  const source = normalized(sql)
  const table = requirement.table.toLowerCase().replace(/[^a-z0-9_]/g, "")
  const column = requirement.column.toLowerCase().replace(/[^a-z0-9_]/g, "")
  const tablePattern = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const columnPattern = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:create table(?: if not exists)? ${tablePattern}[\\s\\S]*?\\b${columnPattern}\\b|alter table ${tablePattern}[\\s\\S]*?add column(?: if not exists)? ${columnPattern}\\b)`, "i").test(source)
}

/** Confere journal e contratos explícitos de tabela/coluna em migrations. */
export function verifyPromotionGate(input: PromotionGateInput): PromotionGateReport {
  const issues: PromotionGateIssue[] = []
  let entries: JournalEntry[] = []
  try {
    const parsed = JSON.parse(input.journalContent) as { entries?: unknown }
    entries = Array.isArray(parsed.entries) ? parsed.entries as JournalEntry[] : []
  } catch {
    issues.push({ kind: "migration_journal", fingerprint: "invalid-migration-journal", message: "Journal de migrations inválido", evidence: "migrations/meta/_journal.json não contém JSON com entries" })
  }
  const tags = new Set(entries.map((entry) => typeof entry.tag === "string" ? entry.tag : "").filter(Boolean))
  for (const migration of input.migrations) {
    const tag = migrationTag(migration.path)
    if (tag && !tags.has(tag)) {
      issues.push({ kind: "migration_journal", fingerprint: `migration-not-journaled:${tag}`, message: `Migration ${tag} existe, mas não está registrada no journal`, evidence: migration.path })
    }
  }
  for (const requirement of input.requiredColumns) {
    if (!input.migrations.some((migration) => hasColumn(migration.content, requirement))) {
      const object = `${requirement.table}.${requirement.column}`
      issues.push({ kind: "schema_contract", fingerprint: `missing-column-migration:${object}`, message: `Código depende de ${object}, mas nenhuma migration o cria`, evidence: requirement.source })
    }
  }
  return { ok: issues.length === 0, issues }
}
