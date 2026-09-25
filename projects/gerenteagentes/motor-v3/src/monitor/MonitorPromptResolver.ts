import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export const MONITOR_RESOLUTION_PROMPT_KEY = 'monitor…ucao'

export interface MonitorPromptMarkers {
  taskId: string
  taskTitle: string
  subtaskId: string
  repository: string
  baseBranch: string
  devBranch: string
  integrationBranch: string
  workspace: string
  blockReason: string
  blockCommand: string
  evidence: string
}

export interface ResolvedMonitorPrompt {
  text: string
  promptId: number
  versionId: number
  /** id da linha em prompts_execucoes (auditoria). */
  executionRowId: number
}

/**
 * Resolve a versão ativa do prompt `monitor.resolucao_bloqueio` da tabela de
 * prompts, substitui os marcadores e audita o uso em `prompts_execucoes`.
 *
 * Segue o mesmo padrão do ManagedAnalysisPromptResolver: a tabela é a fonte
 * da verdade — sem fallback silencioso. Prompt ausente/inativo é erro de
 * configuração e impede a execução do Monitor.
 */
export class MonitorPromptResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(taskIdForAudit: string, markers: MonitorPromptMarkers): Promise<ResolvedMonitorPrompt> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { prompt_id: number; version_id: number; texto: string }>>(
      `SELECT p.id AS prompt_id, v.id AS version_id, v.texto
         FROM prompts_agentes p
         INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id
        WHERE p.chave = ? AND p.status = 'active' LIMIT 1`,
      [MONITOR_RESOLUTION_PROMPT_KEY],
    )
    const row = rows[0]
    if (!row?.texto) {
      throw new Error(`prompt_configuration_missing: prompt ativo não encontrado: ${MONITOR_RESOLUTION_PROMPT_KEY}`)
    }
    const text = render(String(row.texto), {
      '**IDTAREFA**': markers.taskId,
      '**TITULOTAREFA**': markers.taskTitle,
      '**IDSUBTAREFA**': markers.subtaskId,
      '**REPOSITORIO**': markers.repository,
      '**BRANCHBASE**': markers.baseBranch,
      '**BRANCHDEV**': markers.devBranch,
      '**BRANCHINTEGRACAO**': markers.integrationBranch,
      '**WORKSPACE**': markers.workspace,
      '**MOTIVOBLOQUEIO**': markers.blockReason,
      '**COMANDO**': markers.blockCommand,
      '**EVIDENCIA**': markers.evidence,
    })
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO prompts_execucoes
         (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, fallback_usado, created_at)
       VALUES (?, ?, NULL, ?, ?, 0, NOW())`,
      [row.prompt_id, row.version_id, MONITOR_RESOLUTION_PROMPT_KEY, taskIdForAudit],
    )
    await this.pool.query(
      'UPDATE prompts_execucoes SET prompt_final = ?, composicao_json = ? WHERE id = ?',
      [text, JSON.stringify({ key: MONITOR_RESOLUTION_PROMPT_KEY, markers }), result.insertId],
    )
    return { text, promptId: Number(row.prompt_id), versionId: Number(row.version_id), executionRowId: result.insertId }
  }
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [marker, value]) => text.split(marker).join(value), template)
}
