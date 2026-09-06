import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"
import mysql from "mysql2/promise"
import { bootstrapPrompts } from "../prompts/PromptBootstrap.js"
import { BUNDLED_PROMPT_DEFAULTS } from "../prompts/prompt-defaults.generated.js"

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true })

const database = process.env.GERENTE_AGENTES_DATABASE ?? "projeto_640"
const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST ?? "localhost", port: Number(process.env.MYSQL_PORT ?? 3306), user: process.env.MYSQL_USER ?? "root", password: process.env.MYSQL_PASSWORD ?? process.env.MYSQL_ROOT_PASSWORD ?? "", database })

async function exportDefaults(): Promise<void> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT p.chave,v.texto,c.chave AS contract_key,cv.instrucoes FROM prompts_agentes p INNER JOIN prompts_versoes v ON v.id=p.versao_ativa_id LEFT JOIN prompts_contratos_versoes cv ON cv.id=v.contrato_versao_id LEFT JOIN prompts_contratos c ON c.id=cv.contrato_id WHERE p.status='active' ORDER BY p.chave")
  const defaults = Object.fromEntries(rows.map((row) => [String(row.chave), { text: String(row.texto), ...(row.contract_key ? { contractKey: String(row.contract_key), contractInstructions: String(row.instrucoes) } : {}) }]))
  const source = `/** Gerado por \`npm run prompts:export-defaults\`. Deve ser versionado no Git. */\nexport const BUNDLED_PROMPT_DEFAULTS: Readonly<Record<string, { text: string; contractKey?: string; contractInstructions?: string }>> = ${JSON.stringify(defaults, null, 2)}\n`
  await writeFile(resolve("projects/gerenteagentes/motor-v2/src/prompts/prompt-defaults.generated.ts"), source, "utf8")
  console.log(`Defaults exportados: ${rows.length} prompts ativos.`)
}

try {
  if (process.argv.includes("--export")) await exportDefaults()
  else await bootstrapPrompts(connection)
} finally { await connection.end() }
