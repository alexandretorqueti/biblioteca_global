import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export const POSTDEPLOY_VERIFICATION_PROMPT_KEY = 'monitor.verificacao_pos_deploy'

export interface PostDeployPromptTask {
  taskId: string
  title: string
  description: string
  criteria: string
  subtasks: Array<{
    id: number
    titulo: string
    completion_kind: string | null
    status: string
  }>
}

export interface PostDeployPromptCommit {
  commit_sha: string
  commit_message: string
  files_changed: number | null
  insertions: number | null
  deletions: number | null
}

export interface PostDeployPromptTestRun {
  id: number
  phase: string
  status: string
  passed_count: number | null
  failed_count: number | null
  duration_ms: number | null
}

export interface PostDeployPromptMarkers {
  batchId: string
  tasks: PostDeployPromptTask[]
  commits: PostDeployPromptCommit[]
  testRuns: PostDeployPromptTestRun[]
  deployDiagnostics: {
    last_error: string | null
    started_at: Date | null
    finished_at: Date | null
  }
}

export interface ResolvedPostDeployPrompt {
  text: string
  promptId: number
  versionId: number
  /** id da linha em prompts_execucoes (auditoria). */
  executionRowId: number
}

/**
 * Resolve a versão ativa do prompt `monitor.verificacao_pos_deploy` da tabela
 * de prompts, substitui os marcadores e audita o uso em `prompts_execucoes`.
 *
 * Segue o mesmo padrão do MonitorPromptResolver: a tabela é a fonte da
 * verdade — sem fallback silencioso. Prompt ausente/inativo é erro de
 * configuração e impede a execução do verificador.
 */
export class PostDeployPromptResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(batchIdForAudit: string, markers: PostDeployPromptMarkers): Promise<ResolvedPostDeployPrompt> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { prompt_id: number; version_id: number; texto: string }>>(
      `SELECT p.id AS prompt_id, v.id AS version_id, v.texto
         FROM prompts_agentes p
         INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id
        WHERE p.chave = ? AND p.status = 'active' LIMIT 1`,
      [POSTDEPLOY_VERIFICATION_PROMPT_KEY],
    )
    const row = rows[0]
    if (!row?.texto) {
      throw new Error(`prompt_configuration_missing: prompt ativo não encontrado: ${POSTDEPLOY_VERIFICATION_PROMPT_KEY}`)
    }
    const text = render(String(row.texto), {
      '**BATCHID**': markers.batchId,
      '**TAREFAS**': this.renderTasks(markers.tasks),
      '**COMMITS**': this.renderCommits(markers.commits),
      '**TESTRUNS**': this.renderTestRuns(markers.testRuns),
      '**DIAGNOSTICOS**': this.renderDiagnostics(markers.deployDiagnostics),
    })
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO prompts_execucoes
         (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, fallback_usado, created_at)
       VALUES (?, ?, NULL, ?, ?, 0, NOW())`,
      [row.prompt_id, row.version_id, POSTDEPLOY_VERIFICATION_PROMPT_KEY, `batch:${batchIdForAudit}`],
    )
    await this.pool.query(
      'UPDATE prompts_execucoes SET prompt_final = ?, composicao_json = ? WHERE id = ?',
      [text, JSON.stringify({ key: POSTDEPLOY_VERIFICATION_PROMPT_KEY, batchId: batchIdForAudit }), result.insertId],
    )
    return { text, promptId: Number(row.prompt_id), versionId: Number(row.version_id), executionRowId: result.insertId }
  }

  private renderTasks(tasks: PostDeployPromptTask[]): string {
    if (tasks.length === 0) return '_(nenhuma tarefa no batch)_'
    return tasks.map(task => [
      `#### Tarefa ${task.taskId}: ${task.title}`,
      '',
      `**Descrição:** ${task.description}`,
      '',
      `**Critérios de aceite:** ${task.criteria}`,
      '',
      `**Subtarefas:**`,
      ...task.subtasks.map(st => `- ${st.id}. ${st.titulo} [${st.completion_kind ?? 'code_change'}] — ${st.status}`),
    ].join('\n')).join('\n\n')
  }

  private renderCommits(commits: PostDeployPromptCommit[]): string {
    if (commits.length === 0) return '_(nenhum commit registrado)_'
    return commits.slice(0, 20).map(c => [
      `- \`${c.commit_sha.slice(0, 7)}\` ${c.commit_message}`,
      `  - Arquivos: ${c.files_changed ?? '?'}, +${c.insertions ?? '?'}/-${c.deletions ?? '?'}`,
    ].join('\n')).join('\n')
  }

  private renderTestRuns(testRuns: PostDeployPromptTestRun[]): string {
    if (testRuns.length === 0) return '_(nenhum test_run registrado)_'
    return testRuns.slice(0, 10).map(tr => [
      `- TestRun #${tr.id} [${tr.phase}] — ${tr.status}`,
      `  - Passou: ${tr.passed_count ?? '?'}, Falhou: ${tr.failed_count ?? '?'}, Duração: ${tr.duration_ms ?? '?'}ms`,
    ].join('\n')).join('\n')
  }

  private renderDiagnostics(diagnostics: { last_error: string | null; started_at: Date | null; finished_at: Date | null }): string {
    const parts: string[] = []
    if (diagnostics.started_at && diagnostics.finished_at) {
      const durationMs = new Date(diagnostics.finished_at).getTime() - new Date(diagnostics.started_at).getTime()
      parts.push(`**Duração do deploy:** ${(durationMs / 1000).toFixed(1)}s`)
    }
    if (diagnostics.last_error) {
      parts.push(`**Erro registrado:** ${diagnostics.last_error}`)
    }
    return parts.length > 0 ? parts.join('\n\n') : '_(sem diagnósticos de erro)_'
  }
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [marker, value]) => text.split(marker).join(value), template)
}
