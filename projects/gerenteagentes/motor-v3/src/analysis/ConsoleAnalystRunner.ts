import type { AnalysisRunner, TaskSnapshot } from '../coordinator/TaskCoordinator.js'
import { parseAnalystReply, type AnalysisOutcome } from './AnalystReply.js'

export interface AnalystConsole {
  createSession(input: { key: string; agentId: string; metadata: Record<string, unknown> }): Promise<AnalystSession>
  sendMessage(input: { session: AnalystSession; message: string }): Promise<void>
  getSessionStatus(session: AnalystSession): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }>
}

export interface AnalystSession {
  sessionId: string
  sessionKey: string
  agentId: string
}

export interface ConsoleAnalystRunnerConfig {
  timeoutMs: number
  pollIntervalMs: number
}

export class ConsoleAnalystRunner implements AnalysisRunner {
  private readonly config: ConsoleAnalystRunnerConfig

  constructor(private readonly consoleApi: AnalystConsole, config: Partial<ConsoleAnalystRunnerConfig> = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 30 * 60 * 1000,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
    }
  }

  async start(task: TaskSnapshot, executionId: string): Promise<AnalysisOutcome> {
    const session = await this.consoleApi.createSession({
      key: `motor-v3:analysis:${task.taskId}`,
      agentId: task.agentId,
      metadata: { taskId: task.taskId, executionId, phase: 'analysis' },
    })
    await this.consoleApi.sendMessage({ session, message: this.prompt(task) })

    const deadline = Date.now() + this.config.timeoutMs
    while (Date.now() < deadline) {
      const status = await this.consoleApi.getSessionStatus(session)
      if (status.isFailed) throw new Error(status.error ?? 'Sessão do analista falhou')
      if (status.isComplete) {
        if (!status.lastResponse) throw new Error('Analista concluiu sem resposta')
        return parseAnalystReply(status.lastResponse)
      }
      await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs))
    }
    throw new Error(`Timeout aguardando análise da tarefa ${task.taskId}`)
  }

  private prompt(task: TaskSnapshot): string {
    return [
      'Você é o analista técnico do Motor v3.',
      `Tarefa: ${task.title}`,
      `ID: ${task.taskId}`,
      `Repositório autorizado para leitura: ${task.repoPath}`,
      '', 'Descrição da tarefa:', task.description, '',
      'Responda somente em JSON. Se estiver claro, retorne subtarefas, requirements e coverage.',
      'Se faltar informação, retorne kind="perguntas", resumo e perguntas.',
      'Cada subtarefa deve conter seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered e depends_on.',
    ].join('\n')
  }
}
