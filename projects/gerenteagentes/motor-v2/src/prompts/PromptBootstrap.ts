import { AGENT_PROMPT_CATALOG } from "./prompt-catalog.js"
import { OUTPUT_CONTRACT_CATALOG } from "./output-contract-catalog.js"
import { BUNDLED_PROMPT_DEFAULTS } from "./prompt-defaults.generated.js"

export interface PromptBootstrapDb {
  query(sql: string, params?: unknown[]): Promise<unknown>
  execute(sql: string, params?: any[]): Promise<unknown>
}

/** Popula a configuração canônica somente quando o banco ainda não possui prompts. */
export async function bootstrapPrompts(db: PromptBootstrapDb): Promise<void> {
  await db.execute("INSERT IGNORE INTO prompts_mascaras (nome,descricao,tipo_valor,origem,obrigatoria,sensivel,ativa) VALUES ('**CONTRATOSAIDA**','Instruções da versão do contrato vinculada ao prompt','texto','Motor: contrato de saída versionado',1,0,1)")
  for (const contract of OUTPUT_CONTRACT_CATALOG) {
    await db.execute("INSERT IGNORE INTO prompts_contratos (chave,titulo,descricao,status) VALUES (?,?,?,'draft')", [contract.key, contract.title, contract.description])
    const contractRows = (await db.query("SELECT id,versao_ativa_id FROM prompts_contratos WHERE chave=?", [contract.key]) as [{ id: number; versao_ativa_id: number | null }[], unknown])[0]
    const row = contractRows[0]
    if (!row || row.versao_ativa_id) continue
    const bundled = Object.values(BUNDLED_PROMPT_DEFAULTS).find((item) => item.contractKey === contract.key)?.contractInstructions
    const result = await db.execute("INSERT INTO prompts_contratos_versoes (contrato_id,versao,schema_json,exemplo_json,instrucoes,motivo,autor) SELECT ?,1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM prompts_contratos_versoes WHERE contrato_id=?)", [row.id, JSON.stringify(contract.schema), JSON.stringify(contract.example), bundled ?? contract.instructions, "Bootstrap canônico", "sistema", row.id]) as { insertId?: number }
    const versionRows = (await db.query("SELECT id FROM prompts_contratos_versoes WHERE contrato_id=? ORDER BY versao DESC LIMIT 1", [row.id]) as [{ id: number }[], unknown])[0]
    const versionId = Number(result.insertId) || Number(versionRows[0]?.id)
    if (versionId) await db.execute("UPDATE prompts_contratos SET versao_ativa_id=?,status='active' WHERE id=? AND versao_ativa_id IS NULL", [versionId, row.id])
  }
  for (const prompt of AGENT_PROMPT_CATALOG) {
    const bundled = BUNDLED_PROMPT_DEFAULTS[prompt.key]
    await db.execute("INSERT IGNORE INTO prompts_agentes (chave,tipo_agente,situacao,conteudo,origem,marcadores,ativo,titulo,descricao,status) VALUES (?,?,?,?,?,?,1,?,?, 'draft')", [prompt.key, prompt.agentType, prompt.situation, bundled?.text ?? prompt.prompt, prompt.source, JSON.stringify(prompt.markers), prompt.key, `Compositor embarcado: ${prompt.source}`])
    const promptRows = (await db.query("SELECT id,versao_ativa_id FROM prompts_agentes WHERE chave=?", [prompt.key]) as [{ id: number; versao_ativa_id: number | null }[], unknown])[0]
    const row = promptRows[0]
    if (!row || row.versao_ativa_id) continue
    let contractVersionId: number | null = null
    if (prompt.contractKey) {
      const contractRows = (await db.query("SELECT versao_ativa_id FROM prompts_contratos WHERE chave=?", [prompt.contractKey]) as [{ versao_ativa_id: number | null }[], unknown])[0]
      const contract = contractRows[0]
      contractVersionId = Number(contract?.versao_ativa_id) || null
    }
    const result = await db.execute("INSERT INTO prompts_versoes (prompt_id,versao,texto,contrato_versao_id,motivo,autor,validacao) SELECT ?,1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM prompts_versoes WHERE prompt_id=?)", [row.id, bundled?.text ?? prompt.prompt, contractVersionId, "Bootstrap canônico", "sistema", JSON.stringify({ ok: true }), row.id]) as { insertId?: number }
    const versionRows = (await db.query("SELECT id FROM prompts_versoes WHERE prompt_id=? ORDER BY versao DESC LIMIT 1", [row.id]) as [{ id: number }[], unknown])[0]
    const versionId = Number(result.insertId) || Number(versionRows[0]?.id)
    if (versionId) await db.execute("UPDATE prompts_agentes SET versao_ativa_id=?,status='active' WHERE id=? AND versao_ativa_id IS NULL", [versionId, row.id])
  }
}
