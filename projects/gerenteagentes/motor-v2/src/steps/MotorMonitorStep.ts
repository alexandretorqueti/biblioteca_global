/**
 * MotorMonitorStep - Correção via Monitor Motor com lock exclusivo
 */

import type { AgentRuntimeDriver } from '../shared/types/agent-runtime.js'
import { ResourceLeaseService } from '../resources/ResourceLeaseService.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { RESOURCE_KEYS } from '../shared/types/resources.js'
import type { ExecutionContext } from '../shared/types/execution.js'
import type { Db } from '../shared/types/infrastructure.js'

export interface MotorFixInput {
  taskId: string
  subtaskId: string
  reason: string
  evidence: { command: string; excerpt: string }
}

export type MotorFixResult =
  | { kind: 'success'; runId: string }
  | { kind: 'awaiting_user'; runId: string; question: string }
  | { kind: 'waiting_resource'; resourceKey: ResourceKey; waitId: number; position: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout'; reason: string }

export interface MotorMonitorStepConfig {
  monitorAgentId: string
  monitorModel: string
  monitorSessionKey: string
  maxWaitSeconds: number
  maxAttempts: number
  heartbeatIntervalMs: number
  db?: Db
}

export interface MonitorSelection {
  agentId: string
  model: string
  sessionKey: string
}

const DEFAULT_CONFIG: MotorMonitorStepConfig = {
  monitorAgentId: 'programador-senior',
  monitorModel: 'openai/gpt-5.6-terra',
  monitorSessionKey: 'agent:programador-senior:monitor',
  maxWaitSeconds: 600,
  maxAttempts: 60,
  heartbeatIntervalMs: 5000,
}

export class MotorMonitorStep {
  private driver: AgentRuntimeDriver
  private resourceLease: ResourceLeaseService
  private config: MotorMonitorStepConfig

  constructor(
    driver: AgentRuntimeDriver,
    resourceLease: ResourceLeaseService,
    config: Partial<MotorMonitorStepConfig> = {}
  ) {
    this.driver = driver
    this.resourceLease = resourceLease
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async execute(input: MotorFixInput, context: ExecutionContext): Promise<MotorFixResult> {
    return this.runMission(this.buildMission(input, context), context)
  }

  /** Retoma a mesma sessão do Monitor depois de uma resposta no chat da tarefa. */
  async continueAfterUserReply(input: MotorFixInput, context: ExecutionContext, reply: string): Promise<MotorFixResult> {
    return this.runMission(
      `O responsável respondeu à sua pergunta sobre a tarefa ${input.taskId}, subtarefa ${input.subtaskId}:\n\n${reply}\n\n` +
      "Continue a investigação. Se precisar de outra decisão, responda novamente com STATUS: AGUARDANDO_USUARIO e PERGUNTA:. Caso contrário, conclua no contrato de recuperação.",
      context,
    )
  }

  private async runMission(mission: string, context: ExecutionContext): Promise<MotorFixResult> {
    const resourceKey = RESOURCE_KEYS.motorMonitor()

    const acquireResult = await this.resourceLease.acquire(
      resourceKey, context.executionId, context.taskId, this.config.maxWaitSeconds
    )

    if (acquireResult.kind === 'waiting') {
      return { kind: 'waiting_resource', resourceKey, waitId: acquireResult.waitId, position: acquireResult.position }
    }

    if (acquireResult.kind === 'denied') {
      return { kind: 'failed', reason: `Monitor indisponível: ${acquireResult.reason}` }
    }

    const lease = acquireResult.lease

    try {
      const selection = await this.resolveSelection(context.projectSlug)
      const sendResult = await this.driver.sendMessage({
        agentId: selection.agentId,
        sessionKey: selection.sessionKey,
        model: selection.model,
        message: mission,
      })

      if (!sendResult.ok) {
        return { kind: 'failed', reason: `Falha ao enviar missão: ${sendResult.reason ?? 'erro'}` }
      }

      const runId = sendResult.runId!
      const result = await this.waitForCompletion(runId, lease.resourceKey, context.executionId, lease.fencingToken)
      if (result.kind === 'awaiting_user') await this.persistQuestion(context.taskId, result.question)
      return result
    } finally {
      await this.resourceLease.release(lease.resourceKey, context.executionId, lease.fencingToken)
    }
  }

  private async resolveSelection(projectSlug: string | null): Promise<MonitorSelection> {
    if (!projectSlug || !this.config.db) {
      return {
        agentId: this.config.monitorAgentId,
        model: this.config.monitorModel,
        sessionKey: this.config.monitorSessionKey,
      }
    }

    const { rows } = await this.config.db.query(
      `SELECT COALESCE(a.openclaw_agent_id, a.nome) AS agent_id,
              CONCAT(pms.provider, '/', pms.model) AS modelo,
              pms.ordem
       FROM project_model_selection pms
       LEFT JOIN projetos_captados pc ON pc.slug = pms.project_slug
       LEFT JOIN agentes a ON a.id = pc.agente_id
       WHERE pms.project_slug = ? AND pms.tipo = 'MONITOR' AND pms.enabled = 1
       ORDER BY pms.ordem ASC
       LIMIT 1`,
      [projectSlug],
    )
    const row = rows[0]
    if (!row?.agent_id || !row?.modelo) {
      throw new Error(`Configuração de monitor ausente para o projeto ${projectSlug}`)
    }
    const agentId = String(row.agent_id)
    const model = String(row.modelo)
    const modelSlug = model.split('/').at(-1)?.replace(/[^a-zA-Z0-9.-]/g, '_') ?? 'monitor'
    return { agentId, model, sessionKey: `agent:${agentId}:project:${projectSlug}:monitor:${modelSlug}` }
  }

  private async waitForCompletion(
    runId: string, resourceKey: ResourceKey, executionId: string, fencingToken: number
  ): Promise<MotorFixResult> {
    let attempts = 0

    while (attempts < this.config.maxAttempts) {
      const renewResult = await this.resourceLease.renew(resourceKey, executionId, fencingToken)
      if (renewResult.kind === 'lost') {
        return { kind: 'failed', reason: 'Lease perdido durante execução' }
      }

      const status = await this.driver.getRunStatus(runId)
      if (status.status === 'completed') {
        const question = questionFromMonitorReply(status.content)
        if (question) return { kind: 'awaiting_user', runId, question }
        return { kind: 'success', runId }
      }
      if (status.status === 'failed') return { kind: 'failed', reason: 'Monitor falhou' }

      await this.sleep(this.config.heartbeatIntervalMs)
      attempts++
    }

    return { kind: 'timeout', reason: `Timeout: ${this.config.maxAttempts * this.config.heartbeatIntervalMs / 1000}s` }
  }

  private buildMission(input: MotorFixInput, context: ExecutionContext): string {
    return `## Missão Motor Fix\n\n**Tarefa**: ${context.taskId}\n**Subtarefa**: ${input.subtaskId}\n\n### Problema\n${input.reason}\n\n### Evidência\n\`${input.evidence.command}\`\n\`\`\`\n${input.evidence.excerpt}\n\`\`\`\n\nSe precisar de uma decisão do responsável pela tarefa, não suponha a resposta. Encerre sua resposta exatamente com:\n\nSTATUS: AGUARDANDO_USUARIO\nPERGUNTA:\n<sua pergunta objetiva>\n\nCaso contrário, use o contrato normal de recuperação.`
  }

  /** Persiste a pergunta do Monitor no mesmo chat já exibido na tela da tarefa. */
  private async persistQuestion(taskId: string, question: string): Promise<void> {
    if (!this.config.db) throw new Error('DB não configurado para registrar a pergunta do Monitor')
    await this.config.db.query(
      "INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) " +
      "SELECT id, 'monitor', ?, NOW() FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1",
      [question.slice(0, 30_000), taskId, taskId],
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/** Aceita somente uma solicitação explícita, evitando transformar relatórios em perguntas. */
export function questionFromMonitorReply(content: string | undefined): string | null {
  if (!content || !/^STATUS:\s*AGUARDANDO_USUARIO\s*$/mi.test(content)) return null
  const match = content.match(/^PERGUNTA:\s*\n?([\s\S]*?)(?=\n\s*[A-Z_]+:|$)/mi)
  const question = match?.[1]?.trim()
  return question || null
}
