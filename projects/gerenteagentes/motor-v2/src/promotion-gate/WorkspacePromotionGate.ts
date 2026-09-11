import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { verifyPromotionGate, type PromotionGateReport, type SchemaColumnRequirement } from "./PromotionGateVerifier.js"

function requirementsFromSchemaDiff(worktreePath: string, baseBranch: string): SchemaColumnRequirement[] {
  // Contexto amplo preserva a declaração mysqlTable que dá identidade à coluna.
  // Nunca inferir tabela procurando o primeiro `id`/`createdAt` no arquivo: esses
  // nomes se repetem e produzem falso positivo entre tabelas.
  const diff = execFileSync("git", ["diff", "--unified=100000", `${baseBranch}...HEAD`, "--", "projects/gerenteagentes/schema.ts"], { cwd: worktreePath, encoding: "utf8", timeout: 30_000 })
  let table: string | null = null
  const requirements: SchemaColumnRequirement[] = []
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue
    const content = line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : ""
    const tableMatch = /mysqlTable\("([a-zA-Z0-9_]+)"/.exec(content)
    if (tableMatch?.[1]) table = tableMatch[1]
    if (!line.startsWith("+") || !table) continue
    const property = /^\+\s*([A-Za-z_$][\w$]*):\s*\w+\("([a-zA-Z0-9_]+)"/.exec(line)
    const propertyName = property?.[1]
    const column = property?.[2]
    if (propertyName && column) requirements.push({ table, column, source: `schema.ts:${propertyName}` })
  }
  return requirements
}

function changedMigrationFiles(worktreePath: string, baseBranch: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseBranch}...HEAD`, "--", "projects/gerenteagentes/migrations"], { cwd: worktreePath, encoding: "utf8", timeout: 30_000 })
  return output.split("\n")
    .map((path) => path.trim())
    .filter((path) => /^projects\/gerenteagentes\/migrations\/\d+_.+\.sql$/i.test(path))
}

/** Coleta o worktree; a política continua pura em PromotionGateVerifier. */
export function verifyWorkspacePromotionGate(input: { worktreePath: string; baseBranch: string }): PromotionGateReport {
  const requirements = requirementsFromSchemaDiff(input.worktreePath, input.baseBranch)
  const changedMigrations = changedMigrationFiles(input.worktreePath, input.baseBranch)
  // Alterações sem schema/migration não precisam abrir arquivos do projeto.
  if (requirements.length === 0 && changedMigrations.length === 0) return { ok: true, issues: [] }
  const migrationDir = join(input.worktreePath, "projects/gerenteagentes/migrations")
  // Não reprime dívida histórica da base: valida somente migrations e contratos
  // introduzidos por esta promoção.
  const migrations = changedMigrations.map((path) => ({ path: path.replace("projects/gerenteagentes/", ""), content: readFileSync(join(input.worktreePath, path), "utf8") }))
  const journalContent = readFileSync(join(migrationDir, "meta/_journal.json"), "utf8")
  return verifyPromotionGate({ migrations, journalContent, requiredColumns: requirements })
}
