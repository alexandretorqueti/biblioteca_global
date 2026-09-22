import { randomUUID } from 'node:crypto'
import type { AnalysisRunner, TaskSnapshot } from '../coordinator/TaskCoordinator.js'
import { parseAnalystReply, type AnalysisOutcome } from './AnalystReply.js'
import {
  buildAnalysisContextConfirmation,
  buildAnalysisContextMessage,
  buildAnalysisDescriptionReference,
  buildAnalysisPromptActivation,
  buildAnalysisPromptBlock,
  isContextAcknowledgement,
  splitAnalysisDescription,
  splitAnalysisPrompt,
} from './PromptChunking.js'

export interface AnalysisPromptResolver {
  resolve(task: TaskSnapshot, executionId: string, context?: { descriptionReference: string; confirmation: string; chunkCount: number; descriptionLength: number }): Promise<{ text: string; contractText: string; contractSchema: unknown }>
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

export interface AnalystSessionAuditContext {
  taskId: string
  executionId: string
  analysisAttemptId: string
  modelAttempt: number
  model?: string
  phase: string
  messageKey?: string
}

export interface ConsoleAnalystRunnerConfig {
  timeoutMs: number
  pollIntervalMs: number
  modelResolver?: (task: TaskSnapshot) => Promise<string | undefined>
  modelChainResolver?: (task: TaskSnapshot) => Promise<readonly string[]>
  promptResolver?: AnalysisPromptResolver
  modelFailureRecorder?: (model: string, error: Error) => Promise<void>
  onSessionCreated?: (session: AnalystSession, context: AnalystSessionAuditContext) => Promise<void>
  onMessageSent?: (session: AnalystSession, message: string, context: AnalystSessionAuditContext) => Promise<void>
  onResponseReceived?: (session: AnalystSession, response: string, context: AnalystSessionAuditContext) => Promise<void>
  onSessionCompleted?: (session: AnalystSession, context: AnalystSessionAuditContext) => Promise<void>
  onSessionFailure?: (session: AnalystSession | undefined, error: Error, context: AnalystSessionAuditContext) => Promise<void>
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
      onSessionCreated: config.onSessionCreated,
      onMessageSent: config.onMessageSent,
      onResponseReceived: config.onResponseReceived,
      onSessionCompleted: config.onSessionCompleted,
      onSessionFailure: config.onSessionFailure,
    }
  }

  async start(task: TaskSnapshot, executionId: string): Promise<AnalysisOutcome> {
    // Uma nova entrega da mensagem pode reutilizar o mesmo executionId. O
    // identificador abaixo impede que o Console devolva uma sessão/histórico
    // de uma tentativa anterior como se fosse desta execução.
    const analysisAttemptId = randomUUID()
    const descriptionChunks = splitAnalysisDescription(task.description)
    const context = {
      descriptionReference: buildAnalysisDescriptionReference(descriptionChunks.length),
      confirmation: buildAnalysisContextConfirmation(task.description, descriptionChunks.length),
      chunkCount: descriptionChunks.length,
      descriptionLength: (task.description || 'N/A').trim().length || 3,
    }
    const resolvedPrompt = this.config.promptResolver
      ? await this.config.promptResolver.resolve(task, executionId, context)
      : { text: `${this.prompt(task, context.descriptionReference)}\n\n${context.confirmation}`, contractText: '', contractSchema: undefined }
    const models = this.config.modelChainResolver
      ? await this.config.modelChainResolver(task)
      : [await this.config.modelResolver?.(task)].filter((model): model is string => Boolean(model))
    const candidates = models.length > 0 ? models : [undefined]
    let lastError: Error | null = null

    for (const [index, model] of candidates.entries()) {
      let phase = 'create_session'
      const modelAttempt = index + 1
      let session: AnalystSession | undefined
      let sequence = 0
      let lastMessageKey: string | undefined
      const audit = (currentPhase: string, messageKey?: string): AnalystSessionAuditContext => ({
        taskId: task.taskId, executionId, analysisAttemptId, modelAttempt, ...(model ? { model } : {}), phase: currentPhase, ...(messageKey ? { messageKey } : {}),
      })
      const send = async (currentPhase: string, message: string): Promise<void> => {
        const messageKey = `${analysisAttemptId}:${modelAttempt}:${++sequence}`
        lastMessageKey = messageKey
        await this.consoleApi.sendMessage({ session: session!, message })
        await this.config.onMessageSent?.(session!, message, audit(currentPhase, messageKey))
      }
      const wait = async (currentPhase: string): Promise<string> => {
        const response = await this.waitForResult(session!, task)
        await this.config.onResponseReceived?.(session!, response, audit(currentPhase, lastMessageKey))
        return response
      }
      try {
        session = await this.consoleApi.createSession({
          // O prefixo é obrigatório para o Console derivar o agente. O
          // analysisAttemptId também diferencia retries do RabbitMQ, que
          // podem entregar novamente o mesmo executionId.
          key: `agent:${task.agentId}:motor-v3:analysis:${task.taskId}:${executionId}:${analysisAttemptId}:${modelAttempt}`,
          agentId: task.agentId,
          ...(model ? { model } : {}),
          metadata: { taskId: task.taskId, executionId, analysisAttemptId, phase: 'analysis', attempt: modelAttempt },
        })
        await this.config.onSessionCreated?.(session, audit('create_session'))
        phase = 'context'
        await this.sendDescriptionContext(session, task, descriptionChunks, send, wait)
        phase = 'prompt'
        await this.sendAnalysisPrompt(resolvedPrompt.text, send, wait)
        phase = 'response'
        const content = await wait(phase)
        try {
          const outcome = parseAnalystReply(content, resolvedPrompt.contractSchema)
          await this.config.onSessionCompleted?.(session, audit('completed', lastMessageKey))
          return outcome
        } catch (parseError) {
          // Mesmo modelo recebe uma única oportunidade de reparar a resposta
          // com o contrato ativo; somente então há fallback na cadeia.
          const error = asError(parseError)
          phase = 'correction'
          await send(phase, this.correctiveFeedback(error, resolvedPrompt.contractText))
          phase = 'corrected_response'
          const outcome = parseAnalystReply(await wait(phase), resolvedPrompt.contractSchema)
          await this.config.onSessionCompleted?.(session, audit('completed', lastMessageKey))
          return outcome
        }
      } catch (error) {
        lastError = this.annotateError(asError(error), { task, executionId, analysisAttemptId, modelAttempt, model, phase })
        await this.config.onSessionFailure?.(session, lastError, audit(phase))
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

  private async sendDescriptionContext(session: AnalystSession, task: TaskSnapshot, chunks: readonly string[], send: (phase: string, message: string) => Promise<void>, wait: (phase: string) => Promise<string>): Promise<void> {
    for (const [index, chunk] of chunks.entries()) {
      await send('context', buildAnalysisContextMessage(chunk, index, chunks.length))
      const acknowledgement = await wait('context_acknowledgement')
      if (!isContextAcknowledgement(acknowledgement)) {
        throw new Error(`Analista não confirmou o bloco ${index + 1}/${chunks.length}: resposta recebida: ${acknowledgement.slice(0, 200) || '(vazia)'}`)
      }
    }
  }

  private async sendAnalysisPrompt(prompt: string, send: (phase: string, message: string) => Promise<void>, wait: (phase: string) => Promise<string>): Promise<void> {
    const chunks = splitAnalysisPrompt(prompt)
    if (chunks.length === 1) {
      await send('prompt', prompt)
      return
    }
    for (const [index, chunk] of chunks.entries()) {
      await send('prompt_context', buildAnalysisPromptBlock(chunk, index, chunks.length))
      const acknowledgement = await wait('prompt_context_acknowledgement')
      if (!isContextAcknowledgement(acknowledgement)) {
        throw new Error(`Analista não confirmou o bloco de instruções ${index + 1}/${chunks.length}: resposta recebida: ${acknowledgement.slice(0, 200) || '(vazia)'}`)
      }
    }
    await send('prompt', buildAnalysisPromptActivation(chunks.length))
  }

  private annotateError(error: Error, context: { task: TaskSnapshot; executionId: string; analysisAttemptId: string; modelAttempt: number; model?: string; phase: string }): Error {
    const model = context.model ?? 'modelo-padrão-do-Console'
    return new Error(
      `[analysis task=${context.task.taskId} execution=${context.executionId} attempt=${context.analysisAttemptId} model_attempt=${context.modelAttempt} model=${model} phase=${context.phase}] ${error.message}`,
      { cause: error },
    )
  }

  private isModelUnavailable(error: Error): boolean {
    return /(?:401|403|404|429|quota|rate.limit|credit|billing|indispon[ií]vel|model.+not found)/i.test(error.message)
  }

  private prompt(task: TaskSnapshot, description: string): string {
    return [
      'Você é o analista técnico do Motor v3.',
      `Tarefa: ${task.title}`,
      `ID: ${task.taskId}`,
      `Repositório autorizado para leitura: ${task.repoPath}`,
      '', 'Descrição da tarefa:', description, '',
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
