import type { MessageBus } from '../bus/MessageBus.js'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { AnalysisOutcome } from '../analysis/AnalystReply.js'
import type { DerivedTaskStatus } from '../status/DerivedTaskStatus.js'
import { randomUUID } from 'node:crypto'
import { CommandPolicyResolver, type CommandPolicyRepository, type OperationLogger } from '../commands/index.js'
import type { TaskEventSink } from './TaskEventRecorder.js'
import type { AnalysisFailureSink } from './AnalysisFailureBlocker.js'

export type TaskLifecycleStatus = DerivedTaskStatus

export interface TaskSnapshot {
  taskId: string
  title: string
  description: string
  taskType: string
  agentId: string
  projectSlug: string | null
  repoPath: string
  status: TaskLifecycleStatus
  paused: boolean
  terminal: boolean
  analysisStartedAt: string | null
  analysisExecutionId?: string | null
  subtaskCount: number
  /** ID da tarefa da qual esta depende (null = sem dependência). */
  dependsOnTaskId?: string | null
  /** Estado da dependência (carregado pelo repositório). */
  dependencyTerminalStatus?: string | null
  dependencyDeployStatus?: string | null
  dependencyTaskType?: string | null
}

/**
 * Porta mínima de persistência do coordenador.
 *
 * A implementação MySQL será adicionada no ciclo de outbox/persistência. O
 * método claimAnalysis precisa ser atômico no banco (UPDATE condicional ou
 * lock transacional); ele é a proteção definitiva contra duas análises.
 */
export interface TaskCoordinatorRepository {
  getTask(taskId: string): Promise<TaskSnapshot | null>
  claimAnalysis(taskId: string, executionId: string): Promise<boolean>
  releaseAnalysisClaim(taskId: string, executionId: string): Promise<void>
  persistAnalysis(taskId: string, executionId: string, outcome: AnalysisOutcome): Promise<void>
}

/** Presença durável da análise enquanto o processo a executa. */
export interface AnalysisExecutionLeaseRepository {
  acquireAnalysisLease(taskId: string, executionId: string, ttlMs: number): Promise<void>
  heartbeatAnalysisLease(executionId: string, ttlMs: number): Promise<void>
  releaseAnalysisLease(executionId: string): Promise<void>
}

export interface AnalysisRunner {
  start(task: TaskSnapshot, executionId: string): Promise<AnalysisOutcome>
}

export interface TaskCoordinatorConfig {
  analysisExecutionId?: (message: QueueMessage) => string
  commandPolicies?: CommandPolicyRepository
  operationLogger?: OperationLogger
  publishTaskReady?: (source: QueueMessage, payload: Record<string, unknown>) => Promise<void>
  /**
   * Etapa 6 do Monitor-Resolvedor: quando um resume encontra a tarefa
   * bloqueada, reemite `TASK_BLOCKED` para o Monitor trabalhar (despausar
   * → estação Atenção → Monitor acionado). Segue o mesmo contrato de
   * durabilidade do publishTaskReady: falhas propagam para o QueueConsumer.
   */
  publishTaskBlocked?: (source: QueueMessage, reason: string) => Promise<void>
  /** Trilha de auditoria em `tarefa_eventos` (item 6, incidente 862). */
  taskEvents?: TaskEventSink
  /** Bloqueio persistente na falha definitiva de análise (item 2, incidente 862). */
  analysisFailure?: AnalysisFailureSink
  /** Última tentativa antes da DLQ; na falha final o bloqueio é persistido. Default 3. */
  maxAnalysisAttempts?: number
  /** Lease durável usado pelo reconciliador para distinguir análise viva de queda. */
  analysisLeaseTtlMs?: number
}

// Criar/enfileirar apenas registra a tarefa. Toda tarefa nasce pausada e a
// análise só pode começar por uma retomada explícita depois de `paused_at`
// ser removido pela API.
const ANALYSIS_COMMANDS = new Set(['TASK_RESUME_REQUESTED'])

/**
 * Coordena a decisão inicial da tarefa sem conhecer RabbitMQ nem HTTP.
 *
 * O consumidor entrega comandos aqui. O coordenador consulta o estado atual,
 * faz o claim atômico e só então chama o runner do analista.
 */
export class TaskCoordinator {
  private readonly executionIdFactory: (message: QueueMessage) => string
  private readonly commandResolver = new CommandPolicyResolver()
  private readonly commandPolicies?: CommandPolicyRepository
  private readonly operationLogger?: OperationLogger
  private readonly publishTaskReady?: (source: QueueMessage, payload: Record<string, unknown>) => Promise<void>
  private readonly publishTaskBlocked?: (source: QueueMessage, reason: string) => Promise<void>
  private readonly taskEvents?: TaskEventSink
  private readonly analysisFailure?: AnalysisFailureSink
  private readonly maxAnalysisAttempts: number
  private readonly analysisLease?: AnalysisExecutionLeaseRepository
  private readonly analysisLeaseTtlMs: number

  constructor(
    private readonly repository: TaskCoordinatorRepository,
    private readonly runner: AnalysisRunner,
    private readonly bus: MessageBus,
    config: TaskCoordinatorConfig = {},
  ) {
    this.executionIdFactory = config.analysisExecutionId ?? ((message) => `exec-analyze-${message.taskId}-${message.messageId}-attempt-${message.attempt || 1}`)
    this.commandPolicies = config.commandPolicies
    this.operationLogger = config.operationLogger
    this.publishTaskReady = config.publishTaskReady
    this.publishTaskBlocked = config.publishTaskBlocked
    this.taskEvents = config.taskEvents
    this.analysisFailure = config.analysisFailure
    this.maxAnalysisAttempts = config.maxAnalysisAttempts ?? 3
    this.analysisLease = this.hasAnalysisLease(repository) ? repository : undefined
    this.analysisLeaseTtlMs = config.analysisLeaseTtlMs ?? 90_000
  }

  async handle(message: QueueMessage): Promise<void> {
    if (!ANALYSIS_COMMANDS.has(message.type)) return

    const operationId = randomUUID()
    let sequence = 1
    await this.log(operationId, sequence++, 'received', 'executed', message)
    const task = await this.repository.getTask(message.taskId)
    if (!task) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { reasonCode: 'task_not_found' })
      await this.emit('TASK_IGNORED', message, { reason: 'not_found' })
      return
    }

    if (this.commandPolicies) {
      const governed = await this.commandPolicies.findByMessageType(message.type)
      const decision = this.commandResolver.decide(governed?.command, governed?.policies ?? [], {
        paused: task.paused || task.status === 'paused',
        terminal: task.terminal || ['cancelled', 'completed', 'failed'].includes(task.status),
        blocked: task.status === 'blocked',
        subtaskCount: task.subtaskCount,
        analysisClaimed: task.analysisStartedAt !== null,
      })
      if (decision.kind === 'reject') {
        await this.log(operationId, sequence++, 'rejected', 'rejected', message, {
          commandCode: decision.command?.code,
          reasonCode: decision.reasonCode,
          result: { evaluatedPolicies: decision.evaluatedPolicies },
        })
        if (decision.reasonCode === 'task_has_plan') {
          await this.emitTaskReady(message, { reason: decision.reasonCode, subtaskCount: task.subtaskCount })
        } else {
          if (decision.reasonCode === 'task_blocked') await this.publishTaskBlocked?.(message, decision.reasonCode)
          await this.emit('TASK_IGNORED', message, { reason: decision.reasonCode })
        }
        return
      }
      if (decision.policy.actionCode !== 'A21_RESUME_TASK_ANALYSIS') {
        await this.log(operationId, sequence++, 'rejected', 'rejected', message, {
          commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
          actionCode: decision.policy.actionCode, reasonCode: 'unsupported_command_action',
        })
        await this.emit('TASK_IGNORED', message, { reason: 'unsupported_command_action' })
        return
      }
      await this.log(operationId, sequence++, 'decision', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
      await this.log(operationId, sequence++, 'action', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
    }

    const ignoredReason = this.getIgnoredReason(task)
    if (ignoredReason) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { reasonCode: ignoredReason })
      // Despausar tarefa bloqueada cai aqui (status derivado 'blocked'):
      // reemite TASK_BLOCKED para o Monitor-Resolvedor trabalhar.
      if (ignoredReason === 'blocked') await this.publishTaskBlocked?.(message, ignoredReason)
      await this.emit('TASK_IGNORED', message, { reason: ignoredReason })
      return
    }

    const dependencyCheck = this.checkDependencySatisfied(task)
    if (!dependencyCheck.satisfied) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, {
        reasonCode: 'dependency_not_met',
        result: { dependencyTaskId: dependencyCheck.dependencyTaskId, dependencyStatus: dependencyCheck.dependencyStatus, dependencyDeployStatus: dependencyCheck.dependencyDeployStatus },
      })
      await this.recordEvent(task.taskId, 'dependency_not_met', {
        dependencyTaskId: dependencyCheck.dependencyTaskId,
        dependencyStatus: dependencyCheck.dependencyStatus,
        dependencyDeployStatus: dependencyCheck.dependencyDeployStatus,
      })
      await this.emit('TASK_IGNORED', message, { reason: 'dependency_not_met' })
      return
    }

    if (task.subtaskCount > 0 || task.analysisStartedAt !== null) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { reasonCode: task.subtaskCount > 0 ? 'task_has_plan' : 'analysis_already_claimed' })
      if (task.subtaskCount > 0) await this.emitTaskReady(message, { reason: 'plan_exists', subtaskCount: task.subtaskCount })
      else await this.emit('TASK_IGNORED', message, { reason: 'analysis_recovery_in_progress' })
      return
    }

    const executionId = this.executionIdFactory(message)
    const analysisAttempt = message.attempt || 1
    const claimed = await this.repository.claimAnalysis(task.taskId, executionId)
    await this.log(operationId, sequence++, 'primitive', claimed ? 'succeeded' : 'rejected', message, { primitiveCode: 'claim_analysis_atomic', result: { executionId, analysisAttempt }, reasonCode: claimed ? undefined : 'analysis_already_claimed' })
    if (!claimed) {
      await this.emit('TASK_IGNORED', message, { reason: 'analysis_already_claimed', executionId, analysisAttempt })
      return
    }

    let heartbeat: NodeJS.Timeout | undefined
    try {
      if (this.analysisLease) {
        await this.analysisLease.acquireAnalysisLease(task.taskId, executionId, this.analysisLeaseTtlMs)
        heartbeat = this.armAnalysisLeaseHeartbeat(executionId)
      }
      await this.emit('ANALYSIS_SELECTED', message, { executionId, analysisAttempt })
      await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'emit_analysis_selected', result: { executionId, analysisAttempt } })
      await this.emit('ANALYSIS_STARTED', message, { executionId, analysisAttempt })
      await this.recordEvent(task.taskId, 'analysis_started', { executionId, attempt: analysisAttempt })
      // A projeção do status pode já enxergar a última mensagem do usuário e
      // retornar `planned`. O comando durável é a fonte de verdade de que esta
      // execução é uma retomada; preserve isso para o resolvedor do prompt.
      const analysisTask = message.payload.reason === 'clarification_response'
        ? { ...task, status: 'awaiting_clarification' as const }
        : task
      const outcome = await this.runner.start(analysisTask, executionId)
      await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'start_analyst', result: { executionId, analysisAttempt, outcome: outcome.kind } })
      await this.repository.persistAnalysis(task.taskId, executionId, outcome)
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      if (outcome.kind === 'questions') {
        await this.emit('ANALYSIS_CLARIFICATION_REQUESTED', message, { executionId, analysisAttempt, questionCount: outcome.questions.length })
        await this.recordEvent(task.taskId, 'analysis_clarification', { executionId, attempt: analysisAttempt, questionCount: outcome.questions.length })
      } else {
        await this.emit('ANALYSIS_COMPLETED', message, { executionId, analysisAttempt, subtaskCount: outcome.subtasks.length })
        await this.recordEvent(task.taskId, 'analysis_completed', { executionId, attempt: analysisAttempt, subtaskCount: outcome.subtasks.length })
        await this.emitTaskReady(message, { executionId, analysisAttempt, subtaskCount: outcome.subtasks.length })
      }
      await this.log(operationId, sequence++, 'completed', 'succeeded', message, { result: { executionId, analysisAttempt, outcome: outcome.kind } })
    } catch (error) {
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.log(operationId, sequence++, 'primitive', 'failed', message, { primitiveCode: 'start_analyst', result: { executionId, analysisAttempt, error: errorMessage }, reasonCode: 'analyst_failed' })

      // Incidente 862 (item 2): na tentativa final (a próxima parada é a DLQ),
      // a falha precisa virar bloqueio persistente — status derivado `blocked`
      // (estação Atenção) em vez de voltar silenciosamente para `planned`.
      // Tentativas anteriores seguem para o retry do broker sem bloqueio.
      const finalAttempt = analysisAttempt >= this.maxAnalysisAttempts
      if (finalAttempt && this.analysisFailure) {
        try {
          await this.analysisFailure.blockForAnalysisFailure(task.taskId, { executionId, attempt: analysisAttempt, error: errorMessage })
          await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'block_task_for_analysis_failure', result: { executionId, analysisAttempt } })
        } catch (blockError) {
          const blockErrorMessage = blockError instanceof Error ? blockError.message : String(blockError)
          console.error(`[TaskCoordinator] falha ao persistir bloqueio de análise da tarefa ${task.taskId}: ${blockErrorMessage}`)
          await this.log(operationId, sequence++, 'primitive', 'failed', message, { primitiveCode: 'block_task_for_analysis_failure', reasonCode: 'block_persistence_failed', result: { error: blockErrorMessage } })
        }
      }
      await this.recordEvent(task.taskId, 'analysis_failed', { executionId, attempt: analysisAttempt, final: finalAttempt, error: errorMessage.slice(0, 1800) })

      await this.log(operationId, sequence++, 'failed', 'failed', message, { result: { executionId, analysisAttempt, error: errorMessage }, reasonCode: 'analyst_failed' })
      await this.emit('ANALYSIS_FAILED', message, {
        executionId,
        analysisAttempt,
        error: errorMessage,
      })
      throw error
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (this.analysisLease) {
        await this.analysisLease.releaseAnalysisLease(executionId).catch(leaseError => {
          console.warn(`[TaskCoordinator] falha ao remover lease de análise ${executionId}:`, this.errorMessage(leaseError))
        })
      }
    }
  }

  private armAnalysisLeaseHeartbeat(executionId: string): NodeJS.Timeout {
    const intervalMs = Math.max(1_000, Math.min(30_000, Math.floor(this.analysisLeaseTtlMs / 3)))
    const heartbeat = setInterval(() => {
      void this.analysisLease?.heartbeatAnalysisLease(executionId, this.analysisLeaseTtlMs).catch(error => {
        // O lease expira sozinho caso o banco continue indisponível; não há
        // rejeição não tratada e o reconciliador decide somente após expirar.
        console.warn(`[TaskCoordinator] falha ao renovar lease de análise ${executionId}:`, this.errorMessage(error))
      })
    }, intervalMs)
    heartbeat.unref?.()
    return heartbeat
  }

  private hasAnalysisLease(repository: TaskCoordinatorRepository): repository is TaskCoordinatorRepository & AnalysisExecutionLeaseRepository {
    return typeof (repository as Partial<AnalysisExecutionLeaseRepository>).acquireAnalysisLease === 'function'
      && typeof (repository as Partial<AnalysisExecutionLeaseRepository>).heartbeatAnalysisLease === 'function'
      && typeof (repository as Partial<AnalysisExecutionLeaseRepository>).releaseAnalysisLease === 'function'
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Auditoria best-effort: falha de trilha não derruba o fluxo principal. */
  private async recordEvent(taskId: string, evento: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.taskEvents) return
    try {
      await this.taskEvents.record(taskId, evento, 'motor', payload)
    } catch (error) {
      console.warn(`[TaskCoordinator] falha ao registrar evento ${evento} da tarefa ${taskId}:`, error instanceof Error ? error.message : String(error))
    }
  }

  private async emitTaskReady(message: QueueMessage, payload: Record<string, unknown>): Promise<void> {
    // A persistência precisa propagar falhas ao QueueConsumer. O MessageBus
    // deliberadamente captura erros de handlers e não pode ser a garantia de durabilidade.
    await this.publishTaskReady?.(message, payload)
    await this.emit('TASK_READY_FOR_PROGRAMMING', message, payload)
  }

  private async log(operationId: string, sequence: number, phase: 'received' | 'decision' | 'action' | 'primitive' | 'completed' | 'failed' | 'rejected', outcome: 'pending' | 'executed' | 'skipped' | 'rejected' | 'succeeded' | 'failed', message: QueueMessage, extra: Omit<Parameters<OperationLogger['append']>[0], 'operationId' | 'sequence' | 'phase' | 'outcome' | 'messageId' | 'messageType' | 'correlationId' | 'causationId' | 'taskId'> = {}): Promise<void> {
    if (!this.operationLogger) return
    await this.operationLogger.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...extra })
  }

  private getIgnoredReason(task: TaskSnapshot): string | null {
    if (task.paused || task.status === 'paused') return 'paused'
    if (task.terminal || ['cancelled', 'completed', 'failed'].includes(task.status)) return 'terminal'
    if (task.status === 'blocked') return 'blocked'
    return null
  }

  /**
   * Verifica se a dependência entre tarefas (depends_on_task_id) está satisfeita.
   *
   * Regras:
   * - dependsOnTaskId NULL → satisfeita (sem dependência)
   * - dependência do tipo 'desenvolvimento' → exige terminal_status='completed' E deploy_requests.status='succeeded'
   * - dependência do tipo 'verificacao' ou 'automacao' → exige apenas terminal_status='completed'
   * - dependência não encontrada (dependencyTaskType null) → não satisfeita
   */
  private checkDependencySatisfied(task: TaskSnapshot): {
    satisfied: boolean
    dependencyTaskId: string | null
    dependencyStatus: string | null
    dependencyDeployStatus: string | null
  } {
    const dependencyTaskId = task.dependsOnTaskId ?? null
    if (!dependencyTaskId) {
      return { satisfied: true, dependencyTaskId: null, dependencyStatus: null, dependencyDeployStatus: null }
    }

    const dependencyTaskType = task.dependencyTaskType ?? null
    const dependencyStatus = task.dependencyTerminalStatus ?? null
    const dependencyDeployStatus = task.dependencyDeployStatus ?? null

    if (!dependencyTaskType) {
      return { satisfied: false, dependencyTaskId, dependencyStatus, dependencyDeployStatus }
    }

    const isCompleted = dependencyStatus === 'completed'

    if (dependencyTaskType === 'desenvolvimento') {
      const satisfied = isCompleted && dependencyDeployStatus === 'succeeded'
      return { satisfied, dependencyTaskId, dependencyStatus, dependencyDeployStatus }
    }

    if (dependencyTaskType === 'verificacao' || dependencyTaskType === 'automacao') {
      return { satisfied: isCompleted, dependencyTaskId, dependencyStatus, dependencyDeployStatus }
    }

    // Tipo desconhecido: não satisfeita por segurança
    return { satisfied: false, dependencyTaskId, dependencyStatus, dependencyDeployStatus }
  }

  private async emit(eventName: string, source: QueueMessage, payload: Record<string, unknown>): Promise<void> {
    await this.bus.emit(eventName, {
      taskId: source.taskId,
      executionId: payload.executionId as string ?? source.executionId,
      correlationId: source.correlationId ?? source.messageId,
      payload: {
        ...payload,
        sourceMessageId: source.messageId,
        sourceType: source.type,
      },
    })
  }
}
