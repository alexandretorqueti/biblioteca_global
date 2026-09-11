import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { verifyPromotionGate, type PromotionGateReport, type SchemaColumnRequirement } from "./PromotionGateVerifier.js"

function changedSchemaProperties(worktreePath: string, baseBranch: string): string[] {
  const diff = execFileSync("git", ["diff", "--unified=0", `${baseBranch}...HEAD`, "--", "projects/gerenteagentes/schema.ts"], { cwd: worktreePath, encoding: "utf8", timeout: 30_000 })
  return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
}

function changedMigrationFiles(worktreePath: string, baseBranch: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseBranch}...HEAD`, "--", "projects/gerenteagentes/migrations"], { cwd: worktreePath, encoding: "utf8", timeout: 30_000 })
  return output.split("\n")
    .map((path) => path.trim())
    .filter((path) => /^projects\/gerenteagentes\/migrations\/\d+_.+\.sql$/i.test(path))
}

/** Deriva contratos apenas de colunas adicionadas pela branch em promoção. */
function requirementsFromSchema(schema: string, addedLines: readonly string[]): SchemaColumnRequirement[] {
  const requirements: SchemaColumnRequirement[] = []
  for (const line of addedLines) {
    const property = /^\+\s*([A-Za-z_$][\w$]*):\s*\w+\("([a-zA-Z0-9_]+)"/.exec(line)
    if (!property) continue
    const propertyName = property[1]
    const column = property[2]
    if (!propertyName || !column) continue
    const index = schema.indexOf(`${propertyName}:`, Math.max(0, schema.indexOf(`"${column}"`) - 200))
    const before = schema.slice(0, index >= 0 ? index : schema.length)
    const tables = [...before.matchAll(/mysqlTable\("([a-zA-Z0-9_]+)"/g)]
    const table = tables.at(-1)?.[1]
    if (table) requirements.push({ table, column, source: `schema.ts:${propertyName}` })
  }
  return requirements
}

/** Coleta o worktree; a política continua pura em PromotionGateVerifier. */
export function verifyWorkspacePromotionGate(input: { worktreePath: string; baseBranch: string }): PromotionGateReport {
  const addedSchema = changedSchemaProperties(input.worktreePath, input.baseBranch)
  const changedMigrations = changedMigrationFiles(input.worktreePath, input.baseBranch)
  // Alterações sem schema/migration não precisam abrir arquivos do projeto.
  if (addedSchema.length === 0 && changedMigrations.length === 0) return { ok: true, issues: [] }
  const migrationDir = join(input.worktreePath, "projects/gerenteagentes/migrations")
  // Não reprime dívida histórica da base: valida somente migrations e contratos
  // introduzidos por esta promoção.
  const migrations = changedMigrations.map((path) => ({ path: path.replace("projects/gerenteagentes/", ""), content: readFileSync(join(input.worktreePath, path), "utf8") }))
  const journalContent = readFileSync(join(migrationDir, "meta/_journal.json"), "utf8")
  const schema = readFileSync(join(input.worktreePath, "projects/gerenteagentes/schema.ts"), "utf8")
  return verifyPromotionGate({ migrations, journalContent, requiredColumns: requirementsFromSchema(schema, addedSchema) })
}
