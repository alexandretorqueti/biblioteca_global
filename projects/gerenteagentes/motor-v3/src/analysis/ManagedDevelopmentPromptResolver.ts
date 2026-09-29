import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export interface ResolvedDevelopmentPrompt {
  text: string
  executionId: number
}

/**
 * Resolve prompts administráveis para o agente de desenvolvimento.
 *
 * Busca a versão ativa do prompt no banco (tabela prompts_agentes + prompts_versoes),
 * renderiza as máscaras com os valores do contexto de execução e audita a execução
 * em prompts_execucoes. Usa a mesma tabela e padrões do ManagedAnalysisPromptResolver.
 */
export class ManagedDevelopmentPromptResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(input: {
    key: string
    values: Record<string, string>
    fallback: string
    taskId?: string
    subtaskId?: number
  }): Promise<ResolvedDevelopmentPrompt> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id AS prompt_id, v.id AS version_id, v.texto,
              cv.id AS contract_version_id, cv.instrucoes
         FROM prompts_agentes p
         INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id
         LEFT JOIN prompts_contratos_versoes cv ON cv.id = v.contrato_versao_id
        WHERE p.chave = ? AND p.status = 'active' LIMIT 1`,
      [input.key],
    )
    const row = rows[0]
    if (!row?.texto) {
      // Prompt não configurado — usa fallback hardcoded
      return { text: input.fallback, executionId: 0 }
    }

    const instructions = String(row.instrucoes ?? '').trim()
    const rendered = render(String(row.texto), {
      ...input.values,
      '**CONTRATOSAIDA**': instructions,
    })
    const text = instructions && !String(row.texto).includes('**CONTRATOSAIDA**')
      ? `${rendered}\n\nCONTRATO DE SAÍDA OBRIGATÓRIO:\n${instructions}`
      : rendered

    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO prompts_execucoes
         (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, subtarefa_id, fallback_usado, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
      [
        row.prompt_id,
        row.version_id,
        row.contract_version_id ?? null,
        input.key,
        input.taskId ?? null,
        input.subtaskId ?? null,
      ],
    )

    await this.pool.query(
      'UPDATE prompts_execucoes SET prompt_final = ?, composicao_json = ? WHERE id = ?',
      [text, JSON.stringify({ key: input.key, taskId: input.taskId, subtaskId: input.subtaskId }), result.insertId],
    )

    return { text, executionId: result.insertId }
  }
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [marker, value]) => text.split(marker).join(value), template)
}
