/**
 * Resolver de prompts administráveis usado pelo Motor em runtime.
 *
 * Resolve a versão ativa no banco (prompt + contrato de saída vinculado),
 * renderiza as máscaras e injeta o contrato. A tabela é a única fonte de
 * verdade em runtime; o bootstrap canônico só é executado quando ela está
 * vazia.
 *
 * Fica separado de `PromptTemplateEngine.ts` porque importa os catálogos;
 * a API consome apenas as funções puras daquele arquivo (regra: engine é leaf).
 */
import { bootstrapPrompts, type PromptBootstrapDb } from "./PromptBootstrap.js"
import { renderPromptTemplate, type PromptQueryable } from "./PromptTemplateEngine.js"

function renderWithContract(text: string, values: Record<string, unknown>, instructions: string): string {
  const rendered = renderPromptTemplate(text, { ...values, "**CONTRATOSAIDA**": instructions })
  return instructions && !text.includes("**CONTRATOSAIDA**") ? `${rendered}\n\nCONTRATO DE SAÍDA OBRIGATÓRIO:\n${instructions}` : rendered
}

export class ManagedPromptResolver {
  constructor(private readonly db: PromptQueryable) {}

  async resolveDetailed(input: {
    key: string
    values: Record<string, unknown>
    fallback: string
    taskId?: string
    subtaskId?: number
  }): Promise<{ text: string; executionId: number; contractInstructions: string }> {
    let promptId: number | null = null
    let versionId: number | null = null
    let contractVersionId: number | null = null
    let contractInstructions = ""
    let output = ""
    try {
      const loadRow = async () => {
        const rawResult = await this.db.query(
        "SELECT p.id AS prompt_id, v.id AS version_id, v.texto, cv.id AS contract_version_id, cv.instrucoes FROM prompts_agentes p " +
        "INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id " +
        "LEFT JOIN prompts_contratos_versoes cv ON cv.id = v.contrato_versao_id " +
        "WHERE p.chave = ? AND p.status = 'active' LIMIT 1",
        [input.key],
        )
        return (Array.isArray(rawResult) ? rawResult[0] : (rawResult as { rows?: unknown[] }).rows ?? []) as Array<{ prompt_id: number; version_id: number; texto: string; contract_version_id: number | null; instrucoes: string | null }>
      }
      let rows = await loadRow()
      if (!rows[0]) {
        const executableDb = this.db as PromptQueryable & Partial<PromptBootstrapDb>
        if (!executableDb.execute) throw new Error("prompt_configuration_missing: prompt não cadastrado e banco não suporta bootstrap")
        await bootstrapPrompts(executableDb as PromptBootstrapDb)
        rows = await loadRow()
      }
      const row = rows[0]
      if (row) {
        promptId = Number(row.prompt_id)
        versionId = Number(row.version_id)
        contractVersionId = row.contract_version_id == null ? null : Number(row.contract_version_id)
        if (!row.texto) throw new Error(`prompt_configuration_missing: prompt ativo sem texto: ${input.key}`)
        contractInstructions = row.instrucoes ?? ""
        output = renderWithContract(String(row.texto), input.values, contractInstructions)
      }
      if (!row) throw new Error(`prompt_configuration_missing: prompt ativo não encontrado: ${input.key}`)
    } catch (error) {
      throw new Error("prompt_configuration_missing: " + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
    const executionResult = await this.db.query(
      "INSERT INTO prompts_execucoes (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, subtarefa_id, fallback_usado, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
      [promptId, versionId, contractVersionId, input.key, input.taskId ?? null, input.subtaskId ?? null, 0],
    )
    const result = Array.isArray(executionResult) ? executionResult[0] : executionResult
    const executionId = Number((result as { insertId?: number }).insertId ?? 0)
    return { text: output, executionId, contractInstructions }
  }

  async resolve(input: {
    key: string
    values: Record<string, unknown>
    fallback: string
    taskId?: string
    subtaskId?: number
  }): Promise<string> {
    return (await this.resolveDetailed(input)).text
  }

  async recordFinalComposition(executionId: number, finalText: string, composition: unknown): Promise<void> {
    if (!executionId) return
    await this.db.query(
      "UPDATE prompts_execucoes SET prompt_final = ?, composicao_json = ? WHERE id = ?",
      [finalText, JSON.stringify(composition), executionId],
    )
  }
}
