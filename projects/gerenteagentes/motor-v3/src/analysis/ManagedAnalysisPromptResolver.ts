import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TaskSnapshot } from '../coordinator/TaskCoordinator.js'

export interface ResolvedAnalysisPrompt {
  text: string
  contractText: string
  contractSchema: unknown
  executionId: number | null
}

export interface AnalysisPromptContext {
  descriptionReference: string
  confirmation: string
  chunkCount: number
  descriptionLength: number
}

/** Resolve a versão ativa de prompt/contrato da Biblioteca e a audita. */
export class ManagedAnalysisPromptResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(task: TaskSnapshot, executionId: string, context?: AnalysisPromptContext): Promise<ResolvedAnalysisPrompt> {
    const key = task.status === 'awaiting_clarification'
      ? 'analista.retomada_apos_clarificacao'
      : 'analista.primeira_rodada_tarefa'
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id AS prompt_id, v.id AS version_id, v.texto,
              cv.id AS contract_version_id, cv.instrucoes, cv.schema_json, cv.exemplo_json
         FROM prompts_agentes p
         INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id
         LEFT JOIN prompts_contratos_versoes cv ON cv.id = v.contrato_versao_id
        WHERE p.chave = ? AND p.status = 'active' LIMIT 1`, [key],
    )
    const row = rows[0]
    if (!row?.texto) throw new Error(`prompt_configuration_missing: prompt ativo não encontrado: ${key}`)
    const [chatRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT role, texto FROM tarefa_chats c
       INNER JOIN tarefas t ON t.id = c.tarefa_id
       WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
       ORDER BY c.id ASC`, [task.taskId, task.taskId],
    )
    const clarificationHistory = chatRows
      .map(chat => `[${String(chat.role)}] ${String(chat.texto)}`)
      .join('\n')
    const instructions = String(row.instrucoes ?? '').trim()
    const schema = jsonValue(row.schema_json)
    const example = jsonValue(row.exemplo_json)
    const contractText = [
      instructions,
      `JSON SCHEMA OBRIGATÓRIO:\n${JSON.stringify(schema, null, 2)}`,
      `EXEMPLO VÁLIDO:\n${JSON.stringify(example, null, 2)}`,
    ].filter(Boolean).join('\n\n')
    const text = render(String(row.texto), {
      '**TITULOTAREFA**': task.title,
      '**DESCRICAOTAREFA**': context?.descriptionReference ?? task.description,
      '**WORKSPACE**': task.repoPath,
      '**IDTAREFA**': task.taskId,
      '**TIPOTAREFA**': task.taskType,
      '**HISTORICOCLARIFICACAO**': clarificationHistory || 'Sem esclarecimentos anteriores.',
      '**CONTRATOSAIDA**': contractText,
    })
    const promptWithContract = contractText && !String(row.texto).includes('**CONTRATOSAIDA**')
      ? `${text}\n\nCONTRATO DE SAÍDA OBRIGATÓRIO:\n${contractText}` : text
    const finalText = context ? `${promptWithContract}\n\n${context.confirmation}` : promptWithContract
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO prompts_execucoes
         (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, fallback_usado, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW())`,
      [row.prompt_id, row.version_id, row.contract_version_id ?? null, key, task.taskId],
    )
    await this.pool.query(
      'UPDATE prompts_execucoes SET prompt_final = ?, composicao_json = ? WHERE id = ?',
      [finalText, JSON.stringify({ executionId, taskId: task.taskId, key, ...(context ? { taskContext: { chunks: context.chunkCount, descriptionLength: context.descriptionLength } } : {}) }), result.insertId],
    )
    return { text: finalText, contractText, contractSchema: schema, executionId: result.insertId }
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return {} }
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [marker, value]) => text.split(marker).join(value), template)
}
