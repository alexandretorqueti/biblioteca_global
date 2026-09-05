import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import mysql from "mysql2/promise"
import { AGENT_PROMPT_CATALOG } from "../prompts/prompt-catalog.js"
import { OUTPUT_CONTRACT_CATALOG } from "../prompts/output-contract-catalog.js"
import { BUNDLED_PROMPT_DEFAULTS } from "../prompts/prompt-defaults.generated.js"

const database = process.env.GERENTE_AGENTES_DATABASE ?? "projeto_640"
const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST ?? "localhost", port: Number(process.env.MYSQL_PORT ?? 3306), user: process.env.MYSQL_USER ?? "root", password: process.env.MYSQL_PASSWORD ?? process.env.MYSQL_ROOT_PASSWORD ?? "", database })

async function bootstrap(): Promise<void> {
  await connection.execute("INSERT IGNORE INTO prompts_mascaras (nome,descricao,tipo_valor,origem,obrigatoria,sensivel,ativa) VALUES ('**CONTRATOSAIDA**','Instruções da versão do contrato vinculada ao prompt','texto','Motor: contrato de saída versionado',1,0,1)")
  for (const contract of OUTPUT_CONTRACT_CATALOG) {
    await connection.execute("INSERT IGNORE INTO prompts_contratos (chave,titulo,descricao,status) VALUES (?,?,?,'draft')", [contract.key, contract.title, contract.description])
    const [[row]] = await connection.query<mysql.RowDataPacket[]>("SELECT id,versao_ativa_id FROM prompts_contratos WHERE chave=?", [contract.key])
    if (!row) continue
    if (!row.versao_ativa_id) {
      const bundled = Object.values(BUNDLED_PROMPT_DEFAULTS).find((item) => item.contractKey === contract.key)?.contractInstructions
      const [result] = await connection.execute<mysql.ResultSetHeader>("INSERT INTO prompts_contratos_versoes (contrato_id,versao,schema_json,exemplo_json,instrucoes,motivo,autor) SELECT ?,1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM prompts_contratos_versoes WHERE contrato_id=?)", [row.id, JSON.stringify(contract.schema), JSON.stringify(contract.example), bundled ?? contract.instructions, "Bootstrap canônico", "sistema", row.id])
      const versionId = result.insertId || Number((await connection.query<mysql.RowDataPacket[]>("SELECT id FROM prompts_contratos_versoes WHERE contrato_id=? ORDER BY versao DESC LIMIT 1", [row.id]))[0][0]?.id)
      await connection.execute("UPDATE prompts_contratos SET versao_ativa_id=?,status='active' WHERE id=? AND versao_ativa_id IS NULL", [versionId, row.id])
    }
  }
  for (const prompt of AGENT_PROMPT_CATALOG) {
    const bundled = BUNDLED_PROMPT_DEFAULTS[prompt.key]
    await connection.execute("INSERT IGNORE INTO prompts_agentes (chave,tipo_agente,situacao,conteudo,origem,marcadores,ativo,titulo,descricao,status) VALUES (?,?,?,?,?,?,1,?,?, 'draft')", [prompt.key, prompt.agentType, prompt.situation, bundled?.text ?? prompt.prompt, prompt.source, JSON.stringify(prompt.markers), prompt.key, `Compositor embarcado: ${prompt.source}`])
    const [[row]] = await connection.query<mysql.RowDataPacket[]>("SELECT id,versao_ativa_id FROM prompts_agentes WHERE chave=?", [prompt.key])
    if (!row || row.versao_ativa_id) continue
    let contractVersionId: number | null = null
    if (prompt.contractKey) {
      const [[contract]] = await connection.query<mysql.RowDataPacket[]>("SELECT versao_ativa_id FROM prompts_contratos WHERE chave=?", [prompt.contractKey])
      contractVersionId = Number(contract?.versao_ativa_id) || null
    }
    const [result] = await connection.execute<mysql.ResultSetHeader>("INSERT INTO prompts_versoes (prompt_id,versao,texto,contrato_versao_id,motivo,autor,validacao) SELECT ?,1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM prompts_versoes WHERE prompt_id=?)", [row.id, bundled?.text ?? prompt.prompt, contractVersionId, "Bootstrap canônico", "sistema", JSON.stringify({ ok: true }), row.id])
    const versionId = result.insertId || Number((await connection.query<mysql.RowDataPacket[]>("SELECT id FROM prompts_versoes WHERE prompt_id=? ORDER BY versao DESC LIMIT 1", [row.id]))[0][0]?.id)
    await connection.execute("UPDATE prompts_agentes SET versao_ativa_id=?,status='active' WHERE id=? AND versao_ativa_id IS NULL", [versionId, row.id])
  }
}

async function exportDefaults(): Promise<void> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT p.chave,v.texto,c.chave AS contract_key,cv.instrucoes FROM prompts_agentes p INNER JOIN prompts_versoes v ON v.id=p.versao_ativa_id LEFT JOIN prompts_contratos_versoes cv ON cv.id=v.contrato_versao_id LEFT JOIN prompts_contratos c ON c.id=cv.contrato_id WHERE p.status='active' ORDER BY p.chave")
  const defaults = Object.fromEntries(rows.map((row) => [String(row.chave), { text: String(row.texto), ...(row.contract_key ? { contractKey: String(row.contract_key), contractInstructions: String(row.instrucoes) } : {}) }]))
  const source = `/** Gerado por \`npm run prompts:export-defaults\`. Deve ser versionado no Git. */\nexport const BUNDLED_PROMPT_DEFAULTS: Readonly<Record<string, { text: string; contractKey?: string; contractInstructions?: string }>> = ${JSON.stringify(defaults, null, 2)}\n`
  await writeFile(resolve("projects/gerenteagentes/motor-v2/src/prompts/prompt-defaults.generated.ts"), source, "utf8")
  console.log(`Defaults exportados: ${rows.length} prompts ativos.`)
}

try {
  if (process.argv.includes("--export")) await exportDefaults()
  else await bootstrap()
} finally { await connection.end() }
