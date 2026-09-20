import type { AnalysisRunner, TaskSnapshot } from '../coordinator/TaskCoordinator.js'
import { parseAnalystReply, type AnalysisOutcome } from './AnalystReply.js'

export interface AnalysisPromptResolver {
  resolve(task: TaskSnapshot, executionId: string): Promise<{ text: string; contractText: string; contractSchema: unknown }>
}

export interface AnalystConsole {
  createSession(input: { key: string; agentId: string; model?: string; metadata: Record<string, unknown> }): Promise<AnalystSession>
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
  modelResolver?: (task: TaskSnapshot) => Promise<string | undefined>
  modelChainResolver?: (task: TaskSnapshot) => Promise<readonly string[]>
  promptResolver?: AnalysisPromptResolver
  modelFailureRecorder?: (model: string, error: Error) => Promise<void>
}

export class ConsoleAnalystRunner implements AnalysisRunner {
  private readonly config: ConsoleAnalystRunnerConfig

  constructor(private readonly consoleApi: AnalystConsole, config: Partial<ConsoleAnalystRunnerConfig> = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 30 * 60 * 1000,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      modelResolver: config.modelResolver,
      modelChainResolver: config.modelChainResolver,
      promptResolver: config.promptResolver,
      modelFailureRecorder: config.modelFailureRecorder,
    }
  }

  async start(task: TaskSnapshot, executionId: string): Promise<AnalysisOutcome> {
    const resolvedPrompt = this.config.promptResolver
      ? await this.config.promptResolver.resolve(task, executionId)
      : { text: this.prompt(task), contractText: '', contractSchema: undefined }
    const models = this.config.modelChainResolver
      ? await this.config.modelChainResolver(task)
      : [await this.config.modelResolver?.(task)].filter((model): model is string => Boolean(model))
    const candidates = models.length > 0 ? models : [undefined]
    let lastError: Error | null = null

    for (const [index, model] of candidates.entries()) {
      try {
        const session = await this.consoleApi.createSession({
          // Uma sessão por tentativa preserva o modelo e a auditoria; o
          // prefixo é obrigatório para o Console derivar o agente.
          key: `agent:${task.agentId}:motor-v3:analysis:${task.taskId}:${executionId}:${index + 1}`,
          agentId: task.agentId,
          ...(model ? { model } : {}),
          metadata: { taskId: task.taskId, executionId, phase: 'analysis', attempt: index + 1 },
        })
        await this.consoleApi.sendMessage({ session, message: resolvedPrompt.text })
        const content = await this.waitForResult(session, task)
        try {
          return parseAnalystReply(content, resolvedPrompt.contractSchema)
        } catch (parseError) {
          // Mesmo modelo recebe uma única oportunidade de reparar a resposta
          // com o contrato ativo; somente então há fallback na cadeia.
          const error = asError(parseError)
          await this.consoleApi.sendMessage({ session, message: this.correctiveFeedback(error, resolvedPrompt.contractText) })
          return parseAnalystReply(await this.waitForResult(session, task), resolvedPrompt.contractSchema)
        }
      } catch (error) {
        lastError = asError(error)
        if (model && this.isModelUnavailable(lastError)) await this.config.modelFailureRecorder?.(model, lastError)
      }
    }
    throw lastError ?? new Error(`Nenhum modelo configurado para análise da tarefa ${task.taskId}`)
  }

  private async waitForResult(session: AnalystSession, task: TaskSnapshot): Promise<string> {
    const deadline = Date.now() + this.config.timeoutMs
    while (Date.now() < deadline) {
      const status = await this.consoleApi.getSessionStatus(session)
      if (status.isFailed) throw new Error(status.error ?? 'Sessão do analista falhou')
      if (status.isComplete) {
        if (!status.lastResponse) throw new Error('Analista concluiu sem resposta')
        return status.lastResponse
      }
      await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs))
    }
    throw new Error(`Timeout aguardando análise da tarefa ${task.taskId}`)
  }

  private correctiveFeedback(error: Error, contract: string): string {
    return [
      'A resposta anterior não atende ao contrato de análise.',
      `Erro de validação: ${error.message}`,
      'Responda novamente somente com o JSON completo, sem texto adicional.',
      ...(contract ? ['CONTRATO DE SAÍDA OBRIGATÓRIO:', contract] : []),
    ].join('\n')
  }

  private isModelUnavailable(error: Error): boolean {
    return /(?:401|403|404|429|quota|rate.limit|credit|billing|indispon[ií]vel|model.+not found)/i.test(error.message)
  }

  private prompt(task: TaskSnapshot): string {
    return [
      'Você é o analista técnico do Motor v3.',
      `Tarefa: ${task.title}`,
      `ID: ${task.taskId}`,
      `Repositório autorizado para leitura: ${task.repoPath}`,
      '', 'Descrição da tarefa:', task.description, '',
      'Crie a menor quantidade de subtarefas necessária para executar a tarefa com clareza e segurança.',
      'Para alterações triviais, localizadas e independentes, crie apenas uma subtarefa.',
      'Não divida automaticamente a tarefa em preparar, implementar e validar.',
      'Crie múltiplas subtarefas somente quando houver entregas independentes, dependências técnicas reais, arquivos ou domínios distintos, execução paralela ou etapas que possam ser desenvolvidas separadamente.',
      'Escolha validações proporcionais ao risco e ao tipo da alteração.',
      'Não crie teste unitário automaticamente para toda tarefa. Para alterações triviais, a revisão do diff, a validação visual, git diff --check ou testes já existentes podem ser suficientes.',
      'Responda somente em JSON. Se estiver claro, retorne subtarefas, requirements, coverage e estrategia.',
      'Se faltar informação, retorne kind="perguntas", resumo e perguntas.',
      'Cada subtarefa deve conter seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered e depends_on.',
    ].join('\n')
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
