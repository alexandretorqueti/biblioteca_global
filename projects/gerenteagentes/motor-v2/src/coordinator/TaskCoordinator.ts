/**
 * TaskCoordinator - Coordenador principal do Motor v2
 * 
 * Fluxo:
 * 1. Seleciona tarefa planejada -> chama Analista (cria subtarefas)
 * 2. Seleciona subtarefa pendente -> prepara workspace + executa + testa + deploy
 */

import type { Db, TaskRepository } from "../shared/types/infrastructure.js"
import type { Task } from "../shared/types/index.js"
import type { ResourceKey } from "../shared/types/resources.js"
import type { ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import { ResourceLeaseService } from "../resources/ResourceLeaseService.js"
import { RESOURCE_KEYS } from "../shared/types/resources.js"
import { WorkerLauncher } from "../workers/WorkerLauncher.js"
import { type ModelPhase, type ModelSelection } from "../policies/ModelTierPolicy.js"
import { GitWorkspaceManager, taskIntegrationBranch, type TaskPromotionResult } from "../workspaces/GitWorkspaceManager.js"
import { DependencyInstaller, resolveInstallTimeoutMs } from "../workspaces/DependencyInstaller.js"
import { ResourceWaitManager } from "../resources/ResourceWaitManager.js"
import { executionEventBus, type ExecutionEventBus } from "../events/ExecutionEventBus.js"
import { correctionOnlyChangesTests } from "../policies/CorrectionDiffPolicy.js"
import { isBaselineCorrection, withBaselineExcludes } from "../policies/BaselinePolicy.js"
import { digestGateFailure } from "../policies/CarryOverPolicy.js"
import { blockerEvidence } from "../policies/BlockerPolicy.js"
import type { TaskTransition } from "../policies/TaskStateMachine.js"
import { persistTaskClarificationAnswer, fetchPendingTaskClarification, fetchAnsweredTaskClarifications } from "../planning/ClarificationStore.js"
import { createLogger, describeError } from "../shared/logger.js"
import { ConsoleAgentRuntimeDriver, type RemoteSessionFailure } from "../runtime/ConsoleAgentRuntimeDriver.js"
import { getConfigNumber } from "../config/MotorConfigReader.js"
import { execFileSync, execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { SecretProfileManager, resolveGitTopLevel } from "../workspaces/SecretProfileManager.js"
import { validateTaskCompletion, formatPromotionValidationReport } from "../policies/PromotionValidationPolicy.js"
import { isAgentRunFailureWithoutReply } from "../policies/NoReplyFailurePolicy.js"
import { validateProjectId, formatProjectIdValidationReport } from "../policies/ProjectIdValidationPolicy.js"
import { verifyAgentInGateway, formatAgentVerificationReport, shouldBlockEnqueue } from "../policies/GatewayAgentVerificationPolicy.js"
import { PROMOTION_BLOCKER_SQL_FILTER, isPromotionBlocker } from "../policies/PromotionBlockers.js"
import {
  SYSTEM_BLOCK_MAX_AUTO_RETRIES,
  isSystemBlocker,
} from "../policies/SystemBlockers.js"
import {
  orphanBlockedSubtaskSql,
  orphanTaskLevelBlockerSql,
  resolveTaskLevelSystemBlockersSql,
  staleBlockerSweepSql,
  systemBlockedSubtaskSql,
} from "../policies/BlockerSweepQueries.js"
import { TaskFactsStore } from "../database/TaskFactsStore.js"
import { identifyWorkspaceAutoRecovery } from "../policies/WorkspaceAutoRecoveryPolicy.js"
import type { PromotionConflictOrchestrator } from "../promotion-conflicts/PromotionConflictOrchestrator.js"
import type { PromotionConflictCandidate, PromotionConflictPromoterPort } from "../promotion-conflicts/promotion-conflict.types.js"
import type { PromotionRetryCandidate, PromotionRetryPort, PromotionRetryResult } from "../promotion-retries/promotion-retry.types.js"
import type { PromotionRetryOrchestrator } from "../promotion-retries/PromotionRetryOrchestrator.js"
import { verifyWorkspacePromotionGate } from "../promotion-gate/WorkspacePromotionGate.js"
import { planPromotionRecovery } from "../promotion-gate/PromotionRecoveryPlanner.js"
import { createPromotionCorrectionSubtask } from "../planning/CorrectionSubtaskStore.js"
import type { PromotionGateRecoveryCandidate, PromotionGateRecoveryOrchestrator, PromotionGateRecoveryPort } from "../promotion-gate/PromotionGateRecoveryOrchestrator.js"
import type { PromotionGateReport } from "../promotion-gate/PromotionGateVerifier.js"

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
  phase: "analyze" | "execute"
  executionPhase?: import("../shared/types/execution.js").ExecutionPhase
  taskTipo?: Task["tipo"]
  subtaskId?: number
  workspace?: { path: string; branch: string; baseCommit: string }
  /** P1 (2026-09-05): worktree/branch de integração da TAREFA (subtarefas mergeiam aqui). */
  taskWorkspace?: { path: string; projectPath: string; branch: string; baseCommit: string }
  /** Branch raiz do projeto (ex.: base-desenvolvimento) — destino da promoção final. */
  rootBaseBranch?: string
  buildCommand?: string
  testCommand?: string
  repoPath?: string
  projectSlug?: string
  agentId?: string
  baseBranch?: string
  timeoutHandle?: ReturnType<typeof setTimeout>
  lastHeartbeatAt?: Date
  silenceHandle?: ReturnType<typeof setTimeout>
  presenceHeartbeatHandle?: ReturnType<typeof setInterval>
  /** Flag de pause graceful: quando true, worker pausa após terminar fase atual. */
  pendingPause?: boolean
}

export interface TaskCoordinatorConfig {
  maxWorkers?: number
  maxWorkersPerProject?: number
  /** Timeout máximo de um worker; quando omitido usa hard_timeout_ms da tarefa. */
  workerTimeoutMs?: number
}

const DEFAULT_CONFIG: Required<Pick<TaskCoordinatorConfig, 'maxWorkers' | 'maxWorkersPerProject'>> = {
  maxWorkers: 1,
  maxWorkersPerProject: 1,
}

interface UltimoBloqueio {
  kind: string
  excerpt: string
  blockedAt: string
  subtaskId: number | null
}

interface ClarificacaoPendente {
  message: string
  askedAt: string
}

interface PromotionConflictAnalysisView {
  status: string
  confidence: string | null
  recommendation: string | null
  report: string | null
  errorMessage: string | null
  conflictFiles: string[]
  attempts: number
  updatedAt: string
}

function isTaskTipo(value: unknown): value is NonNullable<Task["tipo"]> {
  return value === "desenvolvimento" || value === "automacao" || value === "verificacao"
}

function isLightweightTask(tipo: Task["tipo"] | undefined): boolean {
  return tipo === "automacao" || tipo === "verificacao"
}

/** Citação POSIX de argumento enviado como um único parâmetro ao shell remoto. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

interface SubtaskView {
  id: number
  seq: number
  titulo: string
  status: string
  resultado: string | null
  deliverCount: number
  workspaceStatus: string | null
  workspaceBranch: string | null
  workspaceCommitSha: string | null
  correctionForSubtaskId: number | null
  deliveryHistory: DeliveryHistoryEntry[]
}

/**
 * Registro do histórico de entregas de uma subtarefa.
 * Cada evento (entrega iniciada, gate rejeitado, retorno para rework, bloqueio, conclusão)
 * é uma linha separada — permite auditar quantas vezes a subtarefa foi entregue,
 * quais modelos foram usados, e os motivos de cada rejeição/retorno.
 */
interface DeliveryHistoryEntry {
  id: number
  deliverNumber: number
  model: string | null
  eventType:
    | "delivery_started"
    | "gate_rejected"
    | "return_for_rework"
    | "blocked"
    | "completed"
    | "baseline_red"
    | "integration_conflict"
    | "integration_gate_failed"
  reason: string | null
  createdAt: string
}

interface SubtaskWithTask {
  id: number
  seq: number
  titulo: string
  scope?: string
  acceptanceCriteria?: string[]
  tarefaId: number
  taskExternalId: string
  taskTitulo: string
  taskDescricao: string
  taskTipo: Task["tipo"]
  repoPath: string
  projectSlug: string | null
  branchTrabalho: string | null
  agentId: string
  buildCommand: string | null
  unitTestCommand: string | null
  unitTestExclude: string[]
  maxRework: number | null
  hardTimeoutMs: number | null
  deliverCount: number
  correctionFingerprint?: string | null
}

export class TaskCoordinator implements PromotionConflictPromoterPort, PromotionRetryPort, PromotionGateRecoveryPort {
  private config: TaskCoordinatorConfig
  private activeWorkers = new Map<string, ActiveWorker>()
  private resourceLease: ResourceLeaseService
  private workerLauncher: WorkerLauncher
  private db: Db
  private repository: TaskRepository
  private facts: TaskFactsStore
  private workspaceManager: GitWorkspaceManager
  private waitManager?: ResourceWaitManager
  private eventBus: ExecutionEventBus
  private finalizingExecutions = new Set<string>()
  private activeMaintenance = 0
  /** Deploys não pertencem a um worker; mantê-los separados evita esconder a
   * atividade do Motor enquanto o script externo está em execução. */
  private activeDeployments = new Map<string, { taskId: string; phase: "verify" | "deploy"; startedAt: Date }>()
  private pumping = false
  /** Guarda de reentrância do processDeployQueue (roda fora do guarda pumping). */
  private processingDeployQueue = false
  /** Incidentes ativos por agente. Um incidente gera exatamente um alerta. */
  private consoleIncidents = new Map<string, { id: string; fingerprint: string; openedAt: string; taskIds: Set<string>; taskId: string; subtaskId?: number; phase: "analyze" | "execute" }>()
  private logger = createLogger("TaskCoordinator")
  /** Round-robin: ID da última tarefa agendada para alternar entre tarefas elegíveis. */
  private lastScheduledTaskId: string | null = null
  /** Subtarefas que já esgotaram as retomadas automáticas (evita log repetido). */
  private systemBlockRetryWarned = new Set<number>()

  constructor(
    db: Db,
    repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {},
    workerLauncher = new WorkerLauncher(),
    workspaceManager = new GitWorkspaceManager({ root: process.env.MOTOR_WORKSPACE_ROOT ?? "/tmp/motor-v2-workspaces" }),
    waitManager?: ResourceWaitManager,
    eventBus = executionEventBus,
    private readonly promotionConflictOrchestrator?: PromotionConflictOrchestrator,
    private readonly promotionRetryOrchestrator?: PromotionRetryOrchestrator,
    private readonly promotionGateRecoveryOrchestrator?: PromotionGateRecoveryOrchestrator,
  ) {
    this.db = db
    this.repository = repository
    this.facts = new TaskFactsStore(db)
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.resourceLease = resourceLease
    this.workerLauncher = workerLauncher
    this.workspaceManager = workspaceManager
    this.waitManager = waitManager
    this.eventBus = eventBus
    this.setupEventHandlers()
  }

  async pump(): Promise<void> {
    // Releases de lease e chamadas HTTP podem disparar o pump ao mesmo tempo.
    // Sem essa trava, duas chamadas selecionam a mesma subtarefa antes de ela
    // ser persistida como running: uma inicia o worker e a outra a coloca na
    // fila, sobrescrevendo indevidamente o status da tarefa para paused.
    if (this.pumping) return
    this.pumping = true
    try {
      // Conciliação de clarificações: respostas gravadas no chat da tarefa por
      // caminhos que não notificaram o motor (ex.: insert direto por agente/sessão)
      // são detectadas aqui e retomam a análise sem depender de aviso externo.
      await this.resumeAnsweredClarifications()
      // Desenvolvimento e análise são pistas independentes. Uma subtarefa
      // aguardando recurso não pode interromper a seleção do analista.
      const maxWorkers = this.config.maxWorkers ?? getConfigNumber('motor.max_workers')
      let developmentGuard = 0
      while (this.activeDevelopmentCount() < maxWorkers && developmentGuard < maxWorkers) {
        developmentGuard += 1
        const subtask = await this.selectNextSubtask()
        if (!subtask) break
        this.logger.info("Subtarefa selecionada: #" + subtask.seq + " " + subtask.titulo, {
          taskId: subtask.taskExternalId, subtaskId: subtask.id, projectSlug: subtask.projectSlug ?? undefined,
        })
        const started = await this.startSubtaskExecution(subtask)
        if (!started) break
      }

      // A análise possui exatamente uma vaga global, além de maxWorkers.
      // Esta etapa sempre é avaliada, mesmo com todas as vagas DEV ocupadas
      // ou quando o início de uma subtarefa falhou/entrou em espera.
      if (this.canStartAnalysis()) {
        const task = await this.selectNextTask()
        if (task) {
          this.logger.info("Tarefa selecionada para analise: " + task.id + " (" + task.title + ")", {
            taskId: task.id, projectSlug: task.projectSlug ?? undefined,
          })
          await this.startTaskAnalysis(task)
        }
      }
      await this.reconcileOrphanedReadyTasks()
      // Sistema/higiene antes dos fluxos de promoção: um bloqueio de promoção
      // obsoleto (tarefa já na base) não pode sobrar para o retry tentar
      // promover de novo, nem esconder o estado real da tarefa.
      await this.reconcileStalePromotionBlockers()
      await this.retrySystemBlockedSubtasks()
      await this.releaseOrphanTaskBlockers()
      // O mesmo módulo atende conflitos recém-detectados e conflitos que já
      // estavam bloqueados quando o processo iniciou. schedule() é não
      // bloqueante e o fingerprint persistido impede análises duplicadas.
      if (this.activeWorkers.size === 0 && this.activeDeployments.size === 0) {
        await this.promotionConflictOrchestrator?.reconcilePendingAnalyses()
        await this.promotionRetryOrchestrator?.reconcile()
        await this.promotionGateRecoveryOrchestrator?.reconcile()
      }
    } finally {
      this.pumping = false
    }
    await this.processDeployQueue()
  }

  async recoverPromotionGate(candidate: PromotionGateRecoveryCandidate, report: PromotionGateReport): Promise<void> {
    const task = await this.repository.getTask(candidate.taskId)
    if (!task || report.ok) return
    const recovery = planPromotionRecovery(report.issues)
    if (!recovery) return
    const result = await createPromotionCorrectionSubtask(this.db, task.id, recovery)
    // O gate assume a correção: o bloqueio de promoção perde o sentido. Além de
    // obsoleto, ele é impeditivo — `selectNextSubtask` ignora tarefas com bloqueio
    // ativo, então a própria corretiva nunca seria selecionada. Idempotente e
    // executado mesmo quando a corretiva já existia de uma execução anterior.
    const resolvedBlockers = await this.resolvePromotionBlockers(task.id)
    if (!result.created) return
    await this.saveTaskTransition(task, "subtasks_pending", { errorMessage: "Reconciliação do gate de promoção criou corretiva: " + report.issues.map((issue) => issue.message).join("; ").slice(0, 500) })
    this.logger.warn("Corretiva criada ao reconciliar promoção bloqueada", { taskId: candidate.taskId, issues: report.issues.map((issue) => issue.fingerprint), resolvedBlockers })
  }

  /**
   * Encerra um bloqueio de promoção obsoleto que mantém uma corretiva do gate
   * presa em `pending` (ver `PromotionGateRecoveryOrchestrator.releaseStaleBlockers`).
   */
  async releaseStalePromotionBlocker(taskId: string): Promise<void> {
    const resolvedBlockers = await this.resolvePromotionBlockers(taskId)
    this.logger.warn("Bloqueio de promoção obsoleto encerrado para liberar a corretiva do gate", { taskId, resolvedBlockers })
  }

  /**
   * Remove os bloqueios de promoção (conflito/sujo, estruturado ou legado)
   * quando o gate assume a correção. Devolve quantos foram encerrados.
   */
  private async resolvePromotionBlockers(taskId: string): Promise<number> {
    const numeric = /^\d+$/.test(taskId)
    const lookup = numeric ? "(t.external_id = ? OR t.id = CAST(? AS UNSIGNED))" : "(t.external_id = ?)"
    const params = numeric ? [taskId, taskId] : [taskId]
    const result = await this.db.query(
      "UPDATE bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id SET b.resolved_at = NOW() " +
      "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL AND " + lookup + " AND " + PROMOTION_BLOCKER_SQL_FILTER,
      params,
    )
    return result.affectedRows
  }

  /**
   * Última etapa de uma resolução feita pelo Monitor. O resolvedor nunca toca
   * na base; somente este coordenador, sob o mesmo lock de integração usado
   * pelo fluxo normal, pode promover a branch validada e liberar o deploy.
   */
  async promote(candidate: PromotionConflictCandidate, resolutionBranch: string): Promise<void> {
    const task = await this.repository.getTask(candidate.taskId)
    if (!task) throw new Error("Tarefa não encontrada para promover resolução: " + candidate.taskId)
    if (!candidate.projectSlug) throw new Error("Projeto ausente para promover resolução: " + candidate.taskId)
    // Guarda de segurança: nunca promover com subtarefas abertas (ex.: corretiva
    // pendente criada pelo gate de promoção).
    const { rows: unfinished } = await this.db.query(
      "SELECT id FROM subtarefas WHERE tarefa_id = (SELECT id FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1) " +
      "AND status NOT IN ('verified', 'superseded') LIMIT 1",
      [candidate.taskId, candidate.taskId],
    )
    if (unfinished.length > 0) throw new Error("Subtarefas não estão todas verificadas; não é seguro promover: " + candidate.taskId)

    const executionId = "promotion-resolution-" + randomUUID()
    const promotion = await this.withProjectIntegrationLock(candidate.projectSlug, executionId, task.id, () =>
      this.workspaceManager.promoteTaskBranch({
        repoPath: candidate.repoPath,
        baseBranch: candidate.baseBranch,
        taskBranch: resolutionBranch,
      }),
    )
    if (promotion.kind !== "promoted") {
      throw new Error("A branch de resolução voltou a conflitar com a base: " + promotion.conflictFiles.join(", "))
    }

    // Só agora o bloqueio deixa de existir: a base recebeu o commit e o fato
    // integration_confirmed passa a corresponder ao Git real.
    await this.db.query(
      "UPDATE bloqueios SET resolved_at = NOW() WHERE tarefa_id = (SELECT id FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1) " +
      "AND resolved_at IS NULL AND subtarefa_id IS NULL AND block_command LIKE 'motor-v2:promotion-conflict:%'",
      [candidate.taskId, candidate.taskId],
    )
    await this.saveTaskTransition(task, "execution_completed")
    await this.enqueueDeploy(task.id, candidate.repoPath)
    this.logger.info("Resolução de conflito promovida e deploy enfileirado", {
      taskId: candidate.taskId, resolutionBranch, mergeCommit: promotion.mergeCommit,
    })
  }

  /**
   * Recupera somente a falha transitória "repositório principal sujo".
   * Não remove o bloqueio antes de o merge real entrar na base; se o drift
   * agora virar conflito, converte-o ao fluxo especializado do Monitor.
   */
  async retry(candidate: PromotionRetryCandidate): Promise<PromotionRetryResult> {
    const task = await this.repository.getTask(candidate.taskId)
    if (!task) return { kind: "failed", reason: "Tarefa não encontrada para retentativa: " + candidate.taskId }
    if (!candidate.projectSlug) return { kind: "failed", reason: "Projeto ausente para retentativa: " + candidate.taskId }

    const { rows: unfinished } = await this.db.query(
      "SELECT id FROM subtarefas WHERE tarefa_id = (SELECT id FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1) " +
      "AND status NOT IN ('verified', 'superseded') LIMIT 1",
      [candidate.taskId, candidate.taskId],
    )
    if (unfinished.length > 0) return { kind: "failed", reason: "Subtarefas não estão mais todas verificadas; não é seguro promover" }

    const executionId = "promotion-retry-" + randomUUID()
    let promotion: TaskPromotionResult
    try {
      promotion = await this.withProjectIntegrationLock(candidate.projectSlug, executionId, task.id, () =>
        this.workspaceManager.promoteTaskBranch({
          repoPath: candidate.repoPath, baseBranch: candidate.baseBranch, taskBranch: candidate.taskBranch,
        }),
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return /repositório principal não está limpo para promoção/i.test(reason)
        ? { kind: "still_dirty", reason }
        : { kind: "failed", reason }
    }

    if (promotion.kind === "conflict") {
      const files = promotion.conflictFiles.join(", ") || "(arquivos não listados)"
      const excerpt = "Conflito no merge da branch da tarefa para a base (" + candidate.baseBranch + ") durante retentativa automática. " +
        "Merge cancelado; nada parcial aplicado. Arquivos em conflito: " + files + ". Branch preservada: " + candidate.taskBranch
      const evidence = blockerEvidence("blocked_environment", excerpt)
      await this.db.query(
        "UPDATE bloqueios SET block_command = ?, block_excerpt = ?, blocked_at = NOW() WHERE id = ? AND resolved_at IS NULL",
        [`motor-v2:promotion-conflict:${encodeURIComponent(candidate.baseBranch)}:${encodeURIComponent(candidate.taskBranch)}:${evidence.fingerprint}`, evidence.excerpt, candidate.blockId],
      )
      return { kind: "conflict", files: promotion.conflictFiles }
    }

    await this.db.query("UPDATE bloqueios SET resolved_at = NOW() WHERE id = ? AND resolved_at IS NULL", [candidate.blockId])
    await this.saveTaskTransition(task, "execution_completed")
    await this.enqueueDeploy(task.id, candidate.repoPath)
    this.logger.info("Retentativa de promoção concluída e deploy enfileirado", { taskId: candidate.taskId, mergeCommit: promotion.mergeCommit })
    return { kind: "promoted" }
  }

  /**
   * Encerra bloqueios **obsoletos**: a tarefa já concluiu o ciclo (na base e
   * deployada) e o bloqueio continua aberto. Ele não protege mais nada — só
   * esconde o estado derivado (a tarefa aparece bloqueada/pausada) e mantém a
   * tarefa na fila dos fluxos de promoção.
   *
   * Dois recortes:
   *  - bloqueio de promoção (conflito / repo sujo / falha na promoção) quando a
   *    tarefa já está integrada **ou** deployada — cobre as três gerações do
   *    texto de repo sujo e o caso do lock de integração (#784);
   *  - **qualquer** bloqueio em tarefa integrada **e** deployada com todas as
   *    subtarefas em estado terminal — cobre a família 741/751/753/754/755/756
   *    (resíduos de `spawn git enoent`, `projeto sem configuração operacional`,
   *    deploy antigo) sem tocar em tarefa que ainda tenha trabalho pendente.
   */
  private async reconcileStalePromotionBlockers(): Promise<void> {
    const { rows } = await this.db.query(staleBlockerSweepSql())
    for (const row of rows) {
      const result = await this.db.query(
        "UPDATE bloqueios SET resolved_at = NOW() WHERE id = ? AND resolved_at IS NULL",
        [row.id],
      )
      if (result.affectedRows === 0) continue
      const promocao = isPromotionBlocker(String(row.block_command ?? ""), String(row.block_excerpt ?? ""))
      this.logger.warn(
        promocao
          ? "Bloqueio de promoção obsoleto encerrado (tarefa já integrada)"
          : "Bloqueio obsoleto encerrado (tarefa concluída e deployada)",
        {
          taskId: String(row.external_id ?? row.tarefa_id),
          blockId: Number(row.id),
          subtaskId: row.subtarefa_id == null ? undefined : Number(row.subtarefa_id),
          reason: String(row.block_reason ?? ""),
          integrada: Number(row.integrada) === 1,
          deployada: Number(row.deployada) === 1,
          excerpt: String(row.block_command || row.block_excerpt || "").slice(0, 80),
        },
      )
    }
  }

  /**
   * Retoma subtarefa bloqueada por falha do PRÓPRIO Motor/ambiente
   * (`blocked_environment`, `systemic_failure`, `model_chain_exhausted`) sem
   * runbook. Bloqueio de entrega/promoção fica de fora: retomá-lo sozinho seria
   * pular validação.
   *
   * Cobre dois estados que antes só o runbook resolvia:
   *  1. subtarefa `blocked` com bloqueio aberto de causa do Motor/ambiente;
   *  2. subtarefa `blocked` **sem nenhum bloqueio aberto** (tarefa órfã: a
   *     evidência foi resolvida mas o status ficou `blocked` — ninguém mais
   *     olharia para ela).
   *
   * Guardas comuns: carência de `SYSTEM_BLOCK_COOLDOWN_SECONDS`;
   * tarefa não integrada, não terminal e sem deploy concluído; nenhuma execução
   * ativa para a subtarefa; e teto de {@link SYSTEM_BLOCK_MAX_AUTO_RETRIES}
   * retomadas por subtarefa em 24h.
   */
  private async retrySystemBlockedSubtasks(): Promise<void> {
    const { rows } = await this.db.query(systemBlockedSubtaskSql())
    const candidates: Array<Record<string, unknown>> = [...rows]

    const { rows: orphans } = await this.db.query(orphanBlockedSubtaskSql())
    candidates.push(...orphans)

    for (const row of candidates) {
      const subtaskId = Number(row.subtarefa_id)
      const reason = String(row.block_reason ?? "")
      const orphan = Number(row.orphan) === 1
      if (!orphan && !isSystemBlocker(reason, String(row.block_command), String(row.block_excerpt))) continue
      const { rows: previous } = await this.db.query(
        "SELECT COUNT(*) AS total FROM bloqueios WHERE subtarefa_id = ? AND resolved_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)",
        [subtaskId],
      )
      if (Number(previous[0]?.total ?? 0) >= SYSTEM_BLOCK_MAX_AUTO_RETRIES) {
        if (!this.systemBlockRetryWarned.has(subtaskId)) {
          this.systemBlockRetryWarned.add(subtaskId)
          this.logger.error(
            "Retomadas automáticas esgotadas para subtarefa bloqueada por falha do Motor/ambiente; bloqueio mantido",
            { taskId: String(row.external_id ?? row.tarefa_id ?? ""), subtaskId, seq: Number(row.seq), reason, orphan },
          )
        }
        continue
      }
      await this.db.query(
        "UPDATE subtarefas SET status = 'pending', updated_at = NOW() WHERE id = ? AND status = 'blocked'",
        [subtaskId],
      )
      if (row.block_id != null) {
        await this.db.query("UPDATE bloqueios SET resolved_at = NOW() WHERE id = ? AND resolved_at IS NULL", [row.block_id])
      }
      // O bloqueio espelhado no nível da tarefa tem o mesmo motivo e travaria a
      // seleção: sem resolvê-lo junto, a retomada não produz efeito.
      await this.db.query(resolveTaskLevelSystemBlockersSql(), [Number(row.tarefa_id)])
      this.logger.warn(
        orphan
          ? "Subtarefa retomada automaticamente (estava blocked sem bloqueio aberto — estado órfão)"
          : "Subtarefa retomada automaticamente (bloqueio era do Motor/ambiente, não da entrega)",
        {
          taskId: String(row.external_id ?? row.tarefa_id ?? ""),
          subtaskId,
          seq: Number(row.seq),
          reason,
        },
      )
    }
  }

  /**
   * Encerra bloqueio espelhado no nível da tarefa quando a causa já não existe
   * (a tarefa tem subtarefas e nenhuma está `blocked`). Sem isto, uma subtarefa
   * retomada deixa a tarefa parada para sempre — o espelho segue aberto e a
   * seleção ignora a tarefa (caso real: task-p2-812/bloqueio 841).
   */
  private async releaseOrphanTaskBlockers(): Promise<void> {
    const { rows } = await this.db.query(orphanTaskLevelBlockerSql())
    for (const row of rows) {
      const result = await this.db.query(
        "UPDATE bloqueios SET resolved_at = NOW() WHERE id = ? AND resolved_at IS NULL",
        [row.id],
      )
      if (result.affectedRows === 0) continue
      this.logger.warn("Bloqueio espelhado no nível da tarefa encerrado (nenhuma subtarefa bloqueada)", {
        taskId: String(row.external_id ?? row.tarefa_id),
        blockId: Number(row.id),
        reason: String(row.block_reason ?? ""),
        excerpt: String(row.block_command || row.block_excerpt || "").slice(0, 80),
      })
    }
  }

  private async reconcileOrphanedReadyTasks(): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT t.* FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE f.integration_confirmed_at IS NULL AND f.terminal_status IS NULL " +
      // BUG 789/785 (2026-09-10): com conflito na promoção tarefa→base, a tarefa
      // recebia transição fail (sem terminal_status) e o próximo pump a confirmava
      // como execution_completed SEM o código estar na base — deploy rodava e o
      // status virava deployed, escondendo o bloqueio que deveria aguardar resolução
      // humana. Bloqueio ativo (resolved_at IS NULL) agora impede a reconciliação:
      // a tarefa fica pendente até o bloqueio ser resolvido.
      "AND NOT EXISTS (SELECT 1 FROM bloqueios blk WHERE blk.tarefa_id = t.id AND blk.resolved_at IS NULL) " +
      "AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded'))",
    )
    for (const row of rows) {
      const task = this.mapTask(row)
      // `task.id` é o external_id público (slug); relações usam a FK
      // numérica `tarefas.id`. Nunca enviar o slug para subtarefas.tarefa_id.
      const taskDatabaseId = Number(row.id)
      const { rows: subtasks } = await this.db.query("SELECT id, seq, workspace_commit_sha, workspace_status, completion_kind, status, resultado FROM subtarefas WHERE tarefa_id = ? AND status != 'superseded'", [taskDatabaseId])
      const validation = validateTaskCompletion(subtasks.map((st: Record<string, unknown>) => ({ id: Number(st.id), seq: Number(st.seq), workspaceCommitSha: st.workspace_commit_sha ? String(st.workspace_commit_sha) : null, workspaceStatus: st.workspace_status ? String(st.workspace_status) : null, completionKind: st.completion_kind ? String(st.completion_kind) : null, status: String(st.status), resultado: st.resultado ? String(st.resultado) : null })))
      if (!validation.ok) await this.saveTaskTransition(task, "fail", { errorMessage: validation.reason })
      else await this.saveTaskTransition(task, "execution_completed")
    }
  }

  private async selectNextTask(): Promise<Task | null> {
    const { rows } = await this.db.query(
      "SELECT t.*, pc.slug as project_slug, " +
      "COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug) as agent_id, " +
      "pmc.repo_path, pmc.branch_trabalho, pmc.build_command, pmc.unit_test_command, pmc.unit_test_exclude, " +
      "pmc.default_max_rework, pmc.default_hard_timeout_ms " +
      "FROM tarefas t " +
      "LEFT JOIN projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN agentes a ON pc.agente_id = a.id " +
      "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE f.terminal_status IS NULL AND f.analysis_started_at IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) " +
      "AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) " +
      "AND COALESCE((SELECT c.role FROM tarefa_chats c WHERE c.tarefa_id = t.id AND c.role IN ('analyst', 'user') ORDER BY c.id DESC LIMIT 1), '') <> 'analyst' " +
      "ORDER BY t.created_at ASC LIMIT 25"
    )
    
    const eligibleTasks = rows.map((row) => this.mapTask(row)).filter((task) => {
      // Verifica se já existe um worker de análise ativo para esta tarefa
      const hasActiveAnalysisWorker = [...this.activeWorkers.values()].some(
        (worker) => worker.taskId === task.id && worker.phase === "analyze"
      )
      return !hasActiveAnalysisWorker &&
             !this.consoleIncidents.has(task.agentId) &&
             this.canStartAnalysis()
    })
    
    if (eligibleTasks.length === 0) return null
    
    // Round-robin: alterna entre tarefas elegíveis para evitar que uma tarefa
    // com muitas subtarefas "prenda" o motor enquanto outras aguardam
    // Usa o ID da tarefa como seed para determinar a ordem de rodízio
    const taskIds = eligibleTasks.map(t => t.id).sort()
    const lastTaskId = this.lastScheduledTaskId
    let nextIndex = 0
    
    if (lastTaskId) {
      const lastIndex = taskIds.indexOf(lastTaskId)
      if (lastIndex >= 0) {
        nextIndex = (lastIndex + 1) % eligibleTasks.length
      }
    }
    
    const selectedTask = eligibleTasks[nextIndex]
    if (!selectedTask) return null
    
    this.lastScheduledTaskId = selectedTask.id
    
    return selectedTask
  }

  async getTasksByStatus(since?: string): Promise<{
    tasks: Record<string, Array<{ id: string; agentId: string; title: string; status: string; projectSlug: string | null }>>
    timestamp: string
    count: number
  }> {
    const where = since ? "WHERE t.updated_at > ?" : ""
    const params = since ? [since] : []
    const { rows } = await this.db.query(
      "SELECT t.*, pc.slug as project_slug, " +
      "COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug) as agent_id, " +
      "pmc.repo_path, pmc.branch_trabalho, pmc.build_command, pmc.unit_test_command, pmc.unit_test_exclude, " +
      "pmc.default_max_rework, pmc.default_hard_timeout_ms " +
      "FROM tarefas t " +
      "LEFT JOIN projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN agentes a ON pc.agente_id = a.id " +
      "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      where +
      " ORDER BY t.updated_at ASC",
      params,
    )
    const taskDatabaseIds = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0)
    const subtaskStatusesByTaskId = new Map<number, string[]>()
    if (taskDatabaseIds.length > 0) {
      const placeholders = taskDatabaseIds.map(() => "?").join(", ")
      const { rows: subtaskRows } = await this.db.query(
        "SELECT tarefa_id, status FROM subtarefas WHERE tarefa_id IN (" + placeholders + ")",
        taskDatabaseIds,
      )
      for (const subtask of subtaskRows) {
        const taskDatabaseId = Number(subtask.tarefa_id)
        const statuses = subtaskStatusesByTaskId.get(taskDatabaseId) ?? []
        statuses.push(String(subtask.status ?? "pending"))
        subtaskStatusesByTaskId.set(taskDatabaseId, statuses)
      }
    }
    const tasks: Record<string, Array<{ id: string; agentId: string; title: string; status: string; projectSlug: string | null }>> = {}
    for (const row of rows) {
      const task = this.mapTask(row)
      const status = await this.facts.derive(task.id, task.status)
      const list = tasks[status] ?? (tasks[status] = [])
      list.push({
        id: task.id,
        agentId: task.agentId,
        title: task.title,
        status,
        projectSlug: task.projectSlug,
      })
    }
    return { tasks, timestamp: new Date().toISOString(), count: rows.length }
  }

  private async selectNextSubtask(): Promise<SubtaskWithTask | null> {
    const { rows } = await this.db.query(
      "SELECT s.*, t.external_id as task_external_id, t.titulo as task_titulo, t.descricao as task_descricao, " +
      "t.tipo as task_tipo, " +
      "t.max_rework AS task_max_rework, t.hard_timeout_ms AS task_hard_timeout_ms, " +
      "pc.slug as project_slug, " +
      "COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug) as agent_id, " +
      "pmc.repo_path, pmc.branch_trabalho, pmc.build_command, pmc.unit_test_command, pmc.unit_test_exclude, " +
      "pmc.default_max_rework, pmc.default_hard_timeout_ms " +
      "FROM subtarefas s " +
      "INNER JOIN tarefas t ON s.tarefa_id = t.id " +
      "LEFT JOIN projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN agentes a ON pc.agente_id = a.id " +
      "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      // Uma análise pode ter criado as subtarefas e a tarefa ter sido
      // devolvida manualmente para planned. Nesse caso, o plano já existe e
      // ela deve seguir para execução, não ser analisada novamente.
      // A seleção da fila usa os mesmos fatos do calculador: pausa impede
      // execução; uma subtarefa ativa ou bloqueada impede outra seleção da
      // mesma tarefa. `tarefas.status` fica somente como compatibilidade para
      // os terminais administrativos e a clarificação ainda legada.
      // Se a tarefa tem paused_at mas também tem resource_wait_key, ela está
      // aguardando recurso (não está pausada pelo usuário), então pode ser selecionada.
      "WHERE s.status = 'pending' AND (t.paused_at IS NULL OR t.resource_wait_key IS NOT NULL) " +
      "AND NOT EXISTS (SELECT 1 FROM task_runtime_facts f WHERE f.tarefa_id = t.id AND f.terminal_status IS NOT NULL) " +
      "AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) " +
      "AND COALESCE((SELECT c.role FROM tarefa_chats c WHERE c.tarefa_id = t.id AND c.role IN ('analyst', 'user') ORDER BY c.id DESC LIMIT 1), '') <> 'analyst' " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM subtarefas ativa WHERE ativa.tarefa_id = s.tarefa_id " +
      "AND ativa.status IN ('running', 'delivered', 'verifying')" +
      ") " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM subtarefas bloqueada WHERE bloqueada.tarefa_id = s.tarefa_id " +
      "AND bloqueada.status = 'blocked'" +
      ") " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM subtarefas anterior " +
      "WHERE anterior.tarefa_id = s.tarefa_id AND anterior.seq < s.seq AND anterior.status NOT IN ('verified', 'superseded') " +
      "AND anterior.id != COALESCE(s.correction_for_subtask_id, -1)" +
      ") " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM subtarefas dependencia WHERE JSON_CONTAINS(COALESCE(s.depends_on_subtask_ids, JSON_ARRAY()), CAST(dependencia.id AS JSON)) " +
      "AND dependencia.status NOT IN ('verified', 'superseded')" +
      ") " +
      "ORDER BY s.seq ASC LIMIT 25"
    )
    return rows
      .map((row) => this.mapSubtask(row))
      .find((subtask) => {
        // Verifica se já existe um worker ativo para esta subtarefa
        // (evita seleção duplicada quando o pump é chamado múltiplas vezes rapidamente)
        const hasActiveWorker = [...this.activeWorkers.values()].some(
          (worker) => worker.subtaskId === subtask.id && worker.phase === "execute"
        )
        return !hasActiveWorker && 
               !this.consoleIncidents.has(subtask.agentId) && 
               this.canStartExecution(subtask.projectSlug)
      }) ?? null
  }

  /** Limite de desenvolvimento: máximo global e, por padrão, um por projeto. */
  private canStartExecution(projectSlug: string | null): boolean {
    const maxWorkers = this.config.maxWorkers ?? getConfigNumber('motor.max_workers')
    if (this.activeDevelopmentCount() >= maxWorkers) return false
    return this.canStartProject(projectSlug)
  }

  private activeDevelopmentCount(): number {
    return [...this.activeWorkers.values()].filter((worker) => worker.phase === "execute").length
  }

  /** Há uma única análise em todo o motor, independente dos workers de dev. */
  private canStartAnalysis(): boolean {
    return ![...this.activeWorkers.values()].some((worker) => worker.phase === "analyze")
  }

  private canStartProject(projectSlug: string | null): boolean {
    if (!projectSlug) return true
    const maxWorkersPerProject = this.config.maxWorkersPerProject ?? getConfigNumber('motor.max_workers_per_project')
    let runningForProject = 0
    for (const worker of this.activeWorkers.values()) {
      if (worker.phase === "execute" && worker.projectSlug === projectSlug) runningForProject += 1
    }
    return runningForProject < maxWorkersPerProject
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startTaskAnalysis(task: Task): Promise<boolean> {
    const executionId = "exec-analyze-" + task.id + "-" + Date.now()
    // Análise é um recurso global e separado do lock de execução do projeto.
    // Assim, uma análise pode rodar enquanto há desenvolvimento em qualquer
    // projeto, mas duas análises continuam mutuamente exclusivas.
    const resourceKey = RESOURCE_KEYS.motorAnalysis()
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, task.id, 60)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(task.id, resourceKey, result.waitId, result.position)
        this.logger.info("Tarefa " + task.id + " aguardando recurso", { taskId: task.id, projectSlug: task.projectSlug ?? undefined })
        return false
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    // Preflight de manifesto ANTES de consumir modelo (operação leve, sem materializar)
    const preflightResult = isLightweightTask(task.tipo)
      ? { ok: true as const }
      : await this.runManifestPreflight(task.repoPath, task.projectSlug)
    if (!preflightResult.ok) {
      this.logger.warn("Preflight de manifesto bloqueou análise: " + preflightResult.reason, {
        taskId: task.id, projectSlug: task.projectSlug ?? undefined,
      })
      // Persiste bloqueio ambiental sem consumir modelo
      try {
        const evidence = blockerEvidence("blocked_environment", preflightResult.reason)
        await this.persistTaskBlock(task.id, null, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt)
        await this.saveTaskTransition(task, "fail")
        this.logger.info("Tarefa bloqueada no preflight de manifesto: " + task.id, { taskId: task.id })
      } catch (persistError) {
        this.logger.error("Falha ao persistir bloqueio de preflight: " + describeError(persistError), { taskId: task.id })
      }
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      return false
    }

    this.activeWorkers.set(executionId, {
      taskId: task.id, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "analyze", taskTipo: task.tipo,
      projectSlug: task.projectSlug ?? undefined,
      agentId: task.agentId,
    })

    try {
      await this.registerActiveExecution(executionId, task.id, null, "analyze")
      this.armActiveExecutionHeartbeat(executionId)
      await this.saveTaskTransition(task, "start_analysis", { executionId })

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: task.id, projectSlug: task.projectSlug,
          phase: "analyze", fencingToken, startedAt: new Date(),
        },
        task, repoPath: task.repoPath,
        buildCommand: task.buildCommand, testCommand: task.unitTestCommand,
        modelPhase: "analysis",
        modelChain: await this.getProjectModelChain(task.projectSlug, "analysis"),
      })
      this.armWorkerTimeout(executionId, task.hardTimeoutMs)

      this.logger.info("Worker de analise iniciado: " + task.id + " (" + executionId + ")", {
        taskId: task.id, executionId, phase: "analyze",
      })
      return true
    } catch (error) {
      this.logger.error("Erro ao iniciar analise: " + describeError(error), { taskId: task.id, executionId, phase: "analyze" })
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      this.clearActiveExecutionHeartbeat(executionId)
      await this.removeActiveExecution(executionId)
      this.activeWorkers.delete(executionId)
      return false
    }
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startSubtaskExecution(subtask: SubtaskWithTask): Promise<boolean> {
    const executionId = "exec-execute-" + subtask.id + "-" + Date.now()
    // Sem lease exclusivo por projeto: o controle de paralelismo é feito via
    // maxWorkersPerProject no canStartProject. Cada tarefa tem seu próprio
    // worktree/branch de integração, evitando conflitos de git.

    this.activeWorkers.set(executionId, {
      taskId: subtask.taskExternalId, executionId, resourceKey: null, fencingToken: 0,
      startedAt: new Date(), phase: "execute", subtaskId: subtask.id, taskTipo: subtask.taskTipo,
      repoPath: subtask.repoPath,
      projectSlug: subtask.projectSlug ?? undefined,
      agentId: subtask.agentId,
    })

    try {
      if (!subtask.agentId) throw new Error("Projeto sem agente configurado")
      if (!isLightweightTask(subtask.taskTipo)) this.assertExecutionConfig(subtask)
      // Presença persistida e status running nascem juntos: o reconciliador
      // nunca observa uma subtarefa running sem uma execução correspondente.
      await this.db.transaction(async (tx) => {
        await this.registerActiveExecution(executionId, subtask.taskExternalId, subtask.id, "execute", tx)
        await tx.query("UPDATE subtarefas SET status = 'running', iniciada_em = NOW() WHERE id = ?", [subtask.id])
      })
      this.armActiveExecutionHeartbeat(executionId)
      const parentTask = await this.repository.getTask(subtask.taskExternalId)
      if (parentTask) {
        await this.saveTaskTransition(parentTask, "start_execution")
      }
      let workspace: Awaited<ReturnType<GitWorkspaceManager["prepare"]>> | undefined
      let integrationBranch: string | undefined
      const baseBranch = subtask.branchTrabalho || "base-desenvolvimento"
      if (!isLightweightTask(subtask.taskTipo)) {
        const activeWorkerForBranch = this.activeWorkers.get(executionId)
        if (activeWorkerForBranch) activeWorkerForBranch.baseBranch = baseBranch
        const agentWorkspacePath = await this.getAgentWorkspacePath(subtask.agentId)
        // P1 (Alexandre 2026-09-05): branch de integração por TAREFA. A tarefa
        // ganha worktree + branch próprios (criados da branch raiz do projeto);
        // as subtarefas são derivadas da branch da tarefa (não da base) e
        // mergeiam nela. A base só recebe o merge no fim, com todas as
        // subtarefas integradas e o gate de integração verde.
        const taskWorkspace = await this.workspaceManager.ensureTaskIntegration({
          repoPath: subtask.repoPath,
          agentId: subtask.agentId,
          rootBaseBranch: baseBranch,
          taskId: subtask.taskExternalId,
          ...(agentWorkspacePath ? { agentWorkspacePath } : {}),
        })
        const activeWorker = this.activeWorkers.get(executionId)
        if (activeWorker) {
          activeWorker.taskWorkspace = taskWorkspace
          activeWorker.rootBaseBranch = baseBranch
          activeWorker.buildCommand = subtask.buildCommand ?? undefined
          activeWorker.testCommand = subtask.unitTestCommand ?? undefined
        }
        integrationBranch = taskWorkspace.branch
        workspace = await this.workspaceManager.prepare({
          repoPath: subtask.repoPath,
          agentId: subtask.agentId,
          baseBranch: taskWorkspace.branch,
          taskId: subtask.taskExternalId,
          subtaskId: String(subtask.id),
          attempt: Math.max(1, subtask.deliverCount + 1),
          ...(agentWorkspacePath ? { agentWorkspacePath } : {}),
        })
        if (activeWorker) activeWorker.workspace = workspace
        await this.db.query(
        "UPDATE subtarefas SET workspace_path = ?, workspace_branch = ?, workspace_base_commit = ?, workspace_status = 'active', workspace_created_at = NOW(), workspace_cleaned_at = NULL WHERE id = ?",
          [workspace.path, workspace.branch, workspace.baseCommit, subtask.id],
        )
      }

      const subtaskInfo: SubtaskInfo = {
        id: subtask.id, seq: subtask.seq, titulo: subtask.titulo,
        scope: subtask.scope, acceptanceCriteria: subtask.acceptanceCriteria,
        correctionFingerprint: subtask.correctionFingerprint,
        deliverCount: subtask.deliverCount,
      }

      const task: Task = {
        id: subtask.taskExternalId, chatId: "", agentId: subtask.agentId,
        title: subtask.taskTitulo, description: subtask.taskDescricao, tipo: subtask.taskTipo,
        repoPath: subtask.repoPath, buildCommand: subtask.buildCommand ?? "",
        unitTestCommand: subtask.unitTestCommand ?? "", unitTestExclude: subtask.unitTestExclude,
        baselineMode: "full", status: "running",
        maxRework: subtask.maxRework ?? 3, hardTimeoutMs: subtask.hardTimeoutMs ?? getConfigNumber('motor.worker_timeout_ms'),
        projectSlug: subtask.projectSlug,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: subtask.taskExternalId, projectSlug: subtask.projectSlug,
          phase: "execute", fencingToken: 0, startedAt: new Date(),
          subtaskId: String(subtask.id),
        },
        task, repoPath: workspace?.projectPath ?? subtask.repoPath,
        buildCommand: subtask.buildCommand ?? "", testCommand: subtask.unitTestCommand ?? "",
        subtask: subtaskInfo,
        ...(workspace ? { workBranch: workspace.branch } : {}),
        ...(workspace ? { baseBranch: integrationBranch ?? baseBranch } : {}),
        modelPhase: "development",
        modelChain: await this.getProjectModelChain(subtask.projectSlug, "development"),
      })
      this.armWorkerTimeout(executionId, subtask.hardTimeoutMs ?? getConfigNumber('motor.worker_timeout_ms'))

      this.logger.info("Worker de execucao iniciado: subtarefa #" + subtask.seq + " (" + executionId + ")", {
        taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId, phase: "execute",
        projectSlug: subtask.projectSlug ?? undefined,
      })
      return true
    } catch (error) {
      const reason = error instanceof Error ? (error.message || String(error)) : String(error)
      const transientDb = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|PROTOCOL_CONNECTION_LOST|Connection lost/i.test(reason)
      const activeWorker = this.activeWorkers.get(executionId)
      if (activeWorker) {
        try {
          if (await this.tryRecoverInvalidWorkspace(executionId, activeWorker, `[startup] ${reason}`)) return false
        } catch (recoveryError) {
          this.logger.error("Falha na auto-recuperacao do workspace; seguindo para bloqueio seguro: " + describeError(recoveryError), {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
          })
        }
      }
      // Qualquer falha no preparo/início (repo ausente, configuração ausente,
      // git indisponível) não pode entrar em loop de retry: persistir bloqueio
      // e marcar subtarefa/tarefa como bloqueadas. Falhas transientes de banco
      // ficam pendentes para o próximo pump.
      if (!transientDb) {
        try {
          const environmental = reason.startsWith("Ambiente bloqueado") || reason.includes("ENOENT")
          const evidence = blockerEvidence(environmental ? "blocked_environment" : "systemic_failure", reason)
          await this.db.query(
            "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
            "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
            [subtask.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtask.id],
          )
          await this.db.query("UPDATE subtarefas SET status = 'blocked', updated_at = NOW() WHERE id = ?", [subtask.id])
          const parentTask = await this.repository.getTask(subtask.taskExternalId)
          if (parentTask) await this.saveTaskTransition(parentTask, "fail")
          this.logger.warn("Bloqueio persistido no inicio da execucao (subtarefa " + subtask.id + "): " + reason, {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
          })
        } catch (persistError) {
          this.logger.error("Falha ao persistir bloqueio de inicio: " + describeError(persistError), {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
          })
        }
      } else {
        this.logger.warn("Falha transiente ao iniciar execucao (subtarefa permanece pending): " + reason, {
          taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
        })
      }
      if (activeWorker && this.beginFinalization(executionId, activeWorker)) {
        await this.finishWorker(executionId, activeWorker)
      }
      return false
    }
  }

  async onTaskCompleted(executionId: string, result?: ExecutionResult): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return

    // Verifica se há pendingPause: se sim, pausa a tarefa após completar a fase atual
    if (worker.pendingPause) {
      this.logger.info("Pause graceful: fase completada, pausando tarefa", {
        taskId: worker.taskId,
        executionId,
        phase: worker.phase
      })
      // Limpa também campos de espera de recurso: se resource_wait_key ficasse
      // preenchido, o selectNextSubtask voltaria a selecionar a tarefa pausada
      // (condição "paused_at IS NULL OR resource_wait_key IS NOT NULL").
      await this.db.query(
        "UPDATE tarefas SET paused_at = NOW(), resource_wait_key = NULL, resource_wait_id = NULL, resource_wait_position = NULL, updated_at = NOW() WHERE external_id = ? OR id = CAST(? AS UNSIGNED)",
        [worker.taskId, worker.taskId]
      )
      // Finalização comum libera lease, remove presença persistida e limpa os
      // controles locais sem apagar o workspace da fase recém-concluída.
      await this.finishWorker(executionId, worker, { preserveWorkspace: true })
      this.logger.info("Tarefa pausada com sucesso (pause graceful)", { taskId: worker.taskId })
      return
    }

    try {
    // Uma execução concluída pelo agente é a evidência explícita de que o
    // Console voltou. A retomada só afeta a fila desse agente.
    if (worker.agentId) await this.markConsoleRecovered(worker.agentId, worker)
    if (worker.phase === "analyze") {
      this.publishActivity(worker, { type: "completed" })
      this.logger.info("Analise completada: " + worker.taskId, { taskId: worker.taskId, executionId, phase: "analyze" })
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.saveTaskTransition(task, "analysis_completed")
      }
    } else {
      this.logger.info("Execucao completada: subtarefa " + worker.subtaskId, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId, phase: "execute" })
      if (worker.subtaskId && worker.workspace) {
        // Persiste a evidência antes de integrar. Se o merge falhar, o
        // recuperador ainda consegue validar e repetir a integração.
        if (result?.gitCommitSha) {
          await this.db.query(
            "UPDATE subtarefas SET workspace_commit_sha = ? WHERE id = ?",
            [result.gitCommitSha, worker.subtaskId],
          )
        }
        try {
          let mergeCommit: string | undefined
          if (result?.gitCommitSha) {
            if (!worker.repoPath || !worker.taskWorkspace) {
              throw new Error("entrega aprovada sem repositório ou worktree de integração da tarefa")
            }
            // P1 (Alexandre 2026-09-05): a subtarefa mergeia na BRANCH DA
            // TAREFA, nunca direto na base. Conflito aqui é resolvido pelo
            // agente da subtarefa (re-enfileira); só escala para humano se
            // o conflito se repetir.
            const integration = await this.workspaceManager.integrateIntoTaskBranch({
              repoPath: worker.repoPath,
              taskWorktreePath: worker.taskWorkspace.path,
              workBranch: worker.workspace.branch,
              expectedCommit: result.gitCommitSha,
            })
            if (integration.kind === "conflict") {
              await this.handleSubtaskIntegrationConflict(worker, executionId, integration.conflictFiles, integration.reason)
              return
            }
            // Gate de integração (decisão Alexandre 2026-09-05): build +
            // testes na branch da tarefa após CADA merge de subtarefa.
            // Vermelho → reverte o merge e devolve a subtarefa para rework.
            const gate = await this.runTaskIntegrationGate(worker)
            if (!gate.ok) {
              await this.handleTaskIntegrationGateFailure(worker, executionId, integration.preMergeHead, gate.output)
              return
            }
            // Publica a branch da tarefa a cada merge (durabilidade do estado
            // integrado + visibilidade remota do progresso da tarefa).
            await this.workspaceManager.publishBranch(worker.repoPath, worker.taskWorkspace.branch).catch((publishError: unknown) => {
              this.logger.warn("Falha ao publicar branch da tarefa: " + describeError(publishError), { taskId: worker.taskId })
            })
            mergeCommit = integration.mergeCommit
          }
          await this.db.query(
            "UPDATE subtarefas SET workspace_commit_sha = ?, workspace_status = ? WHERE id = ?",
            [result?.gitCommitSha ?? null, mergeCommit ? "integrated" : "approved", worker.subtaskId],
          )
          if (mergeCommit) {
            this.publishActivity(worker, {
              type: "developer_branch_integrated",
              executionPhase: "publish",
              level: "info",
              message: `Branch ${worker.workspace.branch} integrada na branch da tarefa ${worker.taskWorkspace?.branch} (${mergeCommit}) — gate de integração verde`,
            })
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await this.db.query(
            "UPDATE subtarefas SET workspace_status = 'integration_failed', resultado = ? WHERE id = ?",
            [reason.substring(0, 500), worker.subtaskId],
          )
          // Falha de integração também deixa trilha em bloqueios — sem isso só
          // o errorMessage registrava o ocorrido.
          try {
            const evidence = blockerEvidence("systemic_failure", "Integração falhou: " + reason)
            await this.db.query(
              "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
              "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
              [worker.subtaskId, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, worker.subtaskId],
            )
          } catch (persistError) {
            this.logger.error("Falha ao persistir bloqueio de integracao: " + describeError(persistError), {
              taskId: worker.taskId, subtaskId: worker.subtaskId, executionId,
            })
          }
          this.logger.error("Integracao falhou: " + reason, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId })
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.saveTaskTransition(task, "fail", { errorMessage: reason.substring(0, 500) })
          }
          this.publishActivity(worker, { type: "failed", level: "error", message: reason })
          await this.finishWorker(executionId, worker)
          return
        }
        await this.promoteOriginalAfterTestOnlyCorrection(worker.subtaskId, worker.workspace, result?.gitCommitSha)
      }

      this.publishActivity(worker, { type: "completed" })
      
      // Verificar se todas subtarefas da tarefa estao completas
      if (worker.subtaskId && isLightweightTask(worker.taskTipo)) {
        const { rows } = await this.db.query(
          "SELECT COUNT(*) as pending FROM subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM subtarefas WHERE id = ?) AND status NOT IN ('verified', 'superseded')",
          [worker.subtaskId],
        )
        const task = await this.repository.getTask(worker.taskId)
        if (task) {
          const pending = Number((rows[0] as Record<string, unknown>)?.pending ?? 0)
          await this.saveTaskTransition(task, pending === 0 ? "execution_completed" : "subtasks_pending")
        }
      } else if (worker.subtaskId) {
        const { rows } = await this.db.query(
          "SELECT COUNT(*) as pending FROM subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM subtarefas WHERE id = ?) AND status NOT IN ('verified', 'superseded')",
          [worker.subtaskId]
        )
        const pending = (rows[0] as Record<string, unknown>)?.pending as number
        if (pending === 0) {
          // Validação de promoção: todas as subtarefas devem ter workspaceCommitSha
          // (evidência de código) antes de a tarefa pai ser marcada como completed.
          // Regra: promoção manual sem código não fecha tarefa.
          const { rows: subtasksForValidation } = await this.db.query(
            "SELECT id, seq, workspace_commit_sha, workspace_status, completion_kind, status, resultado FROM subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM subtarefas WHERE id = ?) AND status != 'superseded'",
            [worker.subtaskId]
          )
          const promotionValidation = validateTaskCompletion(
            subtasksForValidation.map((st: Record<string, unknown>) => ({
              id: Number(st.id),
              seq: Number(st.seq),
              workspaceCommitSha: st.workspace_commit_sha ? String(st.workspace_commit_sha) : null,
              workspaceStatus: st.workspace_status ? String(st.workspace_status) : null,
              completionKind: st.completion_kind ? String(st.completion_kind) : null,
              status: String(st.status),
              resultado: st.resultado ? String(st.resultado) : null,
            }))
          )
          if (!promotionValidation.ok) {
            const promotionReason = promotionValidation.reason ?? "Motivo de bloqueio de promoção não informado"
            this.logger.warn("Validação de promoção bloqueou conclusão da tarefa: " + promotionReason, {
              taskId: worker.taskId, executionId,
            })
            // Salvaguarda para dados legados: antes desta validação existir no
            // worker, uma entrega sem commit podia chegar a `verified`. Isso é
            // recuperável e deve voltar para a escada de modelos — não bloquear
            // a tarefa-pai. Falhas de integração continuam bloqueantes porque
            // exigem resolução humana do merge.
            const retryableSubtaskIds = subtasksForValidation
              .filter((st: Record<string, unknown>) => {
                const status = st.workspace_status ? String(st.workspace_status) : null
                const commit = st.workspace_commit_sha ? String(st.workspace_commit_sha).trim() : ""
                const result = st.resultado ? String(st.resultado) : null
                return status !== "integration_failed" && (!commit || isAgentRunFailureWithoutReply(result))
              })
              .map((st: Record<string, unknown>) => Number(st.id))

            const task = await this.repository.getTask(worker.taskId)
            if (task && retryableSubtaskIds.length > 0) {
              const placeholders = retryableSubtaskIds.map(() => "?").join(", ")
              const retryReason = ("Evidência da entrega inválida; reenfileirada para nova execução pela escada de modelos. " + promotionReason).substring(0, 500)
              await this.db.query(
                `UPDATE subtarefas SET status = 'pending', workspace_status = 'evidence_rejected', workspace_commit_sha = NULL, resultado = ?, finalizada_em = NULL, updated_at = NOW() WHERE id IN (${placeholders})`,
                [retryReason, ...retryableSubtaskIds],
              )
              await this.saveTaskTransition(task, "subtasks_pending")
              this.logger.warn("Entrega sem evidência reenfileirada para recuperação automática: " + retryableSubtaskIds.join(", "), {
                taskId: worker.taskId, executionId,
              })
              this.publishActivity(worker, {
                type: "progress",
                level: "warn",
                message: "Entrega sem evidência válida reenfileirada para nova tentativa por outro modelo.",
              })
              await this.finishWorker(executionId, worker)
              return
            }
            if (task) {
              // Persiste bloqueio com motivo auditável
              try {
                const evidence = blockerEvidence("blocked_environment", promotionReason)
                await this.persistTaskBlock(task.id, null, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt)
                await this.saveTaskTransition(task, "fail", { errorMessage: promotionReason.substring(0, 500) })
                this.publishActivity(worker, { type: "failed", level: "error", message: "Validação de promoção falhou" })
              } catch (persistError) {
                this.logger.error("Falha ao persistir bloqueio de promoção: " + describeError(persistError), {
                  taskId: worker.taskId, executionId,
                })
              }
            }
            await this.finishWorker(executionId, worker)
            return
          }

          this.logger.info("Todas subtarefas completas!", { taskId: worker.taskId, executionId })
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            // P1 (Alexandre 2026-09-05): promoção da branch da tarefa para a
            // base. Conflito com a base (drift externo) é SEMPRE resolução
            // humana: merge cancelado (nada parcial aplicado), tarefa
            // bloqueada, worktree/branch da tarefa preservados para o
            // Alexandre resolver. Sem rebase automático.
            if (worker.taskWorkspace && worker.repoPath && worker.rootBaseBranch) {
              // Gate final, antes de tocar a base. A verificação e a criação
              // de corretiva são módulos distintos; falha preserva a branch.
              let promotionGate
              try {
                promotionGate = verifyWorkspacePromotionGate({
                  worktreePath: worker.taskWorkspace.path,
                  baseBranch: worker.rootBaseBranch,
                })
              } catch (error) {
                // Falha para COLETAR evidência não é prova de defeito de código;
                // não cria corretiva espúria. A promoção ainda conserva seus
                // preflights Git e a falha ambiental entra no fluxo existente.
                this.logger.warn("Gate de promoção indisponível para inspeção; mantendo preflight Git: " + describeError(error), { taskId: worker.taskId })
                promotionGate = { ok: true as const, issues: [] }
              }
              if (!promotionGate.ok) {
                const recovery = planPromotionRecovery(promotionGate.issues)
                if (recovery) await createPromotionCorrectionSubtask(this.db, task.id, recovery)
                const report = promotionGate.issues.map((issue) => issue.message).join("; ").slice(0, 500)
                await this.saveTaskTransition(task, "subtasks_pending", { errorMessage: "Gate de promoção reprovado; corretiva criada: " + report })
                this.publishActivity(worker, { type: "progress", executionPhase: "publish", level: "warn", message: "Gate de promoção reprovado; corretiva automática criada antes do merge." })
                this.logger.warn("Gate de promoção reprovado; branch preservada", { taskId: worker.taskId, issues: promotionGate.issues.map((issue) => issue.fingerprint) })
                await this.finishWorker(executionId, worker)
                await this.pump()
                return
              }
              let promotion: TaskPromotionResult | null = null
              try {
                // LOCK DE INTEGRAÇÃO: promoteTaskBranch faz git switch + merge no
                // working tree do repositório PRINCIPAL. Duas promoções concorrentes
                // do mesmo projeto corromperiam o repo. Serializa via lease de banco
                // (project:<slug>:integration) — protege inclusive multi-instância.
                const integrationSlug = worker.projectSlug ?? task.projectSlug
                const promote = () => this.workspaceManager.promoteTaskBranch({
                  repoPath: worker.repoPath!,
                  baseBranch: worker.rootBaseBranch!,
                  taskBranch: worker.taskWorkspace!.branch,
                })
                promotion = integrationSlug
                  ? await this.withProjectIntegrationLock(integrationSlug, executionId, task.id, promote)
                  : await promote()
              } catch (promotionError) {
                const reason = promotionError instanceof Error ? promotionError.message : String(promotionError)
                const blockReason = "Falha na promoção da branch da tarefa: " + reason + ". Branch preservada: " + worker.taskWorkspace.branch
                const isDirtyRepository = /repositório principal não está limpo para promoção/i.test(reason)
                const evidence = blockerEvidence("blocked_environment", blockReason)
                const blockCommand = isDirtyRepository
                  ? `motor-v2:promotion-repo-dirty:${encodeURIComponent(worker.rootBaseBranch!)}:${encodeURIComponent(worker.taskWorkspace.branch)}:0`
                  : "motor-v2:" + evidence.fingerprint
                this.logger.error(blockReason, { taskId: worker.taskId, executionId })
                try {
                  await this.db.query(
                    "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
                    "SELECT tarefa_id, NULL, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
                    [evidence.kind, blockCommand, evidence.excerpt, worker.subtaskId],
                  )
                } catch (persistError) {
                  this.logger.error("Falha ao persistir bloqueio de promoção: " + describeError(persistError), { taskId: worker.taskId, executionId })
                }
                await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) }, { skipBlocker: true })
                this.publishActivity(worker, { type: "failed", level: "error", message: "Promoção da tarefa para a base falhou — resolução humana necessária" })
                await this.finishWorker(executionId, worker)
                return
              }
              if (promotion.kind === "conflict") {
                const files = promotion.conflictFiles.length > 0 ? promotion.conflictFiles.join(", ") : "(arquivos não listados)"
                const blockReason = "Conflito no merge da branch da tarefa para a base (" + worker.rootBaseBranch + ") — resolução humana necessária. Merge cancelado; nada parcial aplicado. Arquivos em conflito: " + files + ". Branch preservada: " + worker.taskWorkspace.branch
                this.logger.error(blockReason, { taskId: worker.taskId, executionId })
                try {
                  const evidence = blockerEvidence("blocked_environment", blockReason)
                  await this.db.query(
                    "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
                    "SELECT tarefa_id, NULL, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
                    [evidence.kind, `motor-v2:promotion-conflict:${encodeURIComponent(worker.rootBaseBranch)}:${encodeURIComponent(worker.taskWorkspace.branch)}:${evidence.fingerprint}`, evidence.excerpt, worker.subtaskId],
                  )
                } catch (persistError) {
                  this.logger.error("Falha ao persistir bloqueio de promoção: " + describeError(persistError), { taskId: worker.taskId, executionId })
                }
                await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) }, { skipBlocker: true })
                this.publishActivity(worker, { type: "failed", level: "error", message: "Conflito no merge da tarefa para a base — resolução humana necessária. Arquivos: " + files })
                // NÃO purga: worktree e branch da tarefa ficam preservados para resolução manual.
                await this.finishWorker(executionId, worker)
                // Análises usam modelos do mesmo ambiente dos workers. Só
                // iniciamos imediatamente quando o Motor ficou ocioso; caso
                // contrário o reconciliador agenda assim que houver segurança.
                if (this.activeWorkers.size === 0 && this.activeDeployments.size === 0) {
                  this.promotionConflictOrchestrator?.schedule({
                    taskId: task.id,
                    agentId: task.agentId,
                    repoPath: worker.repoPath,
                    baseBranch: worker.rootBaseBranch,
                    taskBranch: worker.taskWorkspace.branch,
                    reportedFiles: promotion.conflictFiles,
                  })
                }
                return
              }
              this.publishActivity(worker, {
                type: "developer_branch_integrated",
                executionPhase: "publish",
                level: "info",
                message: `Branch da tarefa ${worker.taskWorkspace.branch} promovida para ${worker.rootBaseBranch} (${promotion.mergeCommit})`,
              })
            }
            // Trabalho promovido para a base: marca como completed
            await this.saveTaskTransition(task, "execution_completed")
            
            // Publicação é agrupada e só começa quando todos os workers
            // terminarem. A tarefa permanece completed enquanto aguarda.
            if (worker.repoPath) {
              await this.enqueueDeploy(worker.taskId, worker.repoPath)
              this.publishActivity(worker, { type: "completed", level: "info", message: "Deploy agendado para quando o Motor ficar ocioso" })
              // Tarefa concluída: purgar worktrees/branches residuais (a1..aN)
              this.purgeTaskArtifactsFireAndForget(worker.taskId, worker.repoPath)
            }
          }
        } else {
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.saveTaskTransition(task, "subtasks_pending")
          }
        }
      }
    }

    await this.finishWorker(executionId, worker)
    } catch (error) {
      this.logger.error("Falha ao finalizar sucesso da execução " + executionId + ": " + describeError(error), { taskId: worker.taskId, executionId })
      await this.finishWorker(executionId, worker)
      throw error
    }
  }

  async onTaskFailed(executionId: string, error: string, kind = "error", sessionFailure?: RemoteSessionFailure): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    const failure = `[${kind}] ${error}`

    try {
      if (await this.tryRecoverInvalidWorkspace(executionId, worker, failure)) return
    } catch (recoveryError) {
      this.logger.error("Falha na auto-recuperacao do workspace; seguindo para bloqueio seguro: " + describeError(recoveryError), {
        taskId: worker.taskId, subtaskId: worker.subtaskId, executionId,
      })
    }

    const systemic = sessionFailure?.classification === "systemic"
    const transient = systemic || sessionFailure?.classification === "transient" || kind === "timeout" || kind === "lease_lost" || kind === "lease_expired" || kind === "lost"
    this.publishActivity(worker, { type: "failed", level: "error", message: failure })

    this.logger.error("Falha: " + failure, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId, phase: worker.phase })

    if (systemic && worker.agentId) this.pauseAgentQueue(worker, sessionFailure)

    try {
      if (worker.phase === "analyze") {
        const task = await this.repository.getTask(worker.taskId)
        if (task) {
          await this.saveTaskTransition(task, transient ? "recover" : "fail", { errorMessage: "Analise falhou: " + failure })
          if (!transient && worker.repoPath) this.purgeTaskArtifactsFireAndForget(worker.taskId, worker.repoPath)
        }
      } else {
        if (worker.subtaskId) {
          await this.db.query(
            "UPDATE subtarefas SET status = ?, resultado = ? WHERE id = ?",
            [transient ? "pending" : "blocked", failure.substring(0, 500), worker.subtaskId],
          )
        }
        const task = await this.repository.getTask(worker.taskId)
        if (task) {
          await this.saveTaskTransition(task, transient ? "recover" : "fail", { errorMessage: failure.substring(0, 500) })
          // P1: com branch de integração por tarefa, a falha definitiva
          // PRESERVA worktrees/branches da tarefa (evidência para investigação
          // humana; a branch da tarefa também está publicada no origin). A
          // purga só acontece na conclusão com sucesso.
          if (!transient && worker.repoPath && !worker.taskWorkspace) this.purgeTaskArtifactsFireAndForget(worker.taskId, worker.repoPath)
        }
      }
    } finally {
      await this.finishWorker(executionId, worker)
    }
  }

  /**
   * Recupera uma única vez falhas inequívocas de worktree ocorridas antes de
   * qualquer commit. O registro resolvido em bloqueios funciona como auditoria
   * e contador persistente entre pumps/restarts. Repetição cai no fluxo normal
   * de bloqueio humano, evitando loop e perda silenciosa de evidência.
   */
  private async tryRecoverInvalidWorkspace(
    executionId: string,
    worker: ActiveWorker,
    failure: string,
  ): Promise<boolean> {
    if (!worker.subtaskId) return false

    const { rows } = await this.db.query(
      "SELECT workspace_commit_sha FROM subtarefas WHERE id = ? LIMIT 1",
      [worker.subtaskId],
    )
    const workspaceCommitSha = rows[0]?.workspace_commit_sha ? String(rows[0].workspace_commit_sha) : null
    const decision = identifyWorkspaceAutoRecovery({
      error: failure,
      phase: worker.phase,
      subtaskId: worker.subtaskId,
      workspaceCommitSha,
    })
    if (!decision.recoverable || !decision.fingerprint || !decision.reason) return false

    const command = `motor-v2:auto-recover-workspace:${decision.fingerprint}`
    const { rows: priorRows } = await this.db.query(
      "SELECT COUNT(*) AS total FROM bloqueios WHERE subtarefa_id = ? AND block_command = ?",
      [worker.subtaskId, command],
    )
    if (Number(priorRows[0]?.total ?? 0) > 0) {
      this.logger.warn("Auto-recuperacao de workspace ja utilizada; escalando para bloqueio humano", {
        taskId: worker.taskId, subtaskId: worker.subtaskId, executionId,
      })
      return false
    }

    await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at, resolved_at) " +
        "SELECT tarefa_id, ?, 'blocked_environment', ?, ?, NOW(), NOW() FROM subtarefas WHERE id = ?",
        [worker.subtaskId, command, decision.reason, worker.subtaskId],
      )
      await tx.query(
        "UPDATE subtarefas SET status = 'pending', workspace_status = 'auto_recovery_pending', workspace_commit_sha = NULL, resultado = ?, finalizada_em = NULL, updated_at = NOW() WHERE id = ? AND workspace_commit_sha IS NULL",
        [`[auto_recovery] ${decision.reason}`.slice(0, 500), worker.subtaskId],
      )
    })

    this.publishActivity(worker, {
      type: "system_recovered",
      level: "warn",
      message: "Workspace Git inválido detectado; tentativa descartada e subtarefa reenfileirada uma vez.",
    })
    this.logger.warn("Workspace invalido recuperado automaticamente; subtarefa reenfileirada", {
      taskId: worker.taskId, subtaskId: worker.subtaskId, executionId,
    })
    await this.finishWorker(executionId, worker)
    return true
  }

  /**
   * Pausa somente novas execuções do agente afetado. Tarefas já pendentes
   * continuam pendentes; não são convertidas em bloqueios individuais.
   */
  private pauseAgentQueue(worker: ActiveWorker, failure?: RemoteSessionFailure): void {
    const agentId = worker.agentId!
    const active = this.consoleIncidents.get(agentId)
    if (active) {
      active.taskIds.add(worker.taskId)
      return
    }
    const incidentId = randomUUID()
    const incident = {
      id: incidentId,
      fingerprint: failure?.fingerprint ?? "console-unavailable",
      openedAt: failure?.occurredAt ?? new Date().toISOString(),
      taskIds: new Set([worker.taskId]),
      taskId: worker.taskId,
      subtaskId: worker.subtaskId,
      phase: worker.phase,
    }
    this.consoleIncidents.set(agentId, incident)
    this.logger.error("Fila do agente pausada após falha sistêmica do Console", {
      agentId, incidentId, code: failure?.code, message: failure?.message,
    })
    // O evento é emitido uma única vez por incidente ativo. Repetições de
    // falha enquanto a fila está pausada não geram spam.
    this.eventBus.publish({
      type: "system_alert",
      executionId: worker.executionId,
      taskId: worker.taskId,
      subtaskId: worker.subtaskId,
      phase: worker.phase,
      level: "error",
      agentId,
      incidentId,
      message: `Fila do agente ${agentId} pausada: Console indisponível${failure?.message ? ` — ${failure.message}` : ""}`,
      timestamp: new Date(),
    })
  }

  /** Retomada explícita da fila após uma verificação de saúde do Console. */
  async markConsoleRecovered(agentId: string, source?: ActiveWorker): Promise<boolean> {
    const incident = this.consoleIncidents.get(agentId)
    if (!incident) return false
    this.consoleIncidents.delete(agentId)
    for (const taskId of incident.taskIds) {
      const task = await this.repository.getTask(taskId)
      if (!task) continue
      await this.db.query(
        "UPDATE tarefas SET paused_at = NULL, updated_at = NOW() WHERE external_id = ? OR id = CAST(? AS UNSIGNED)",
        [taskId, taskId],
      )
    }
    this.eventBus.publish({
      type: "system_recovered",
      executionId: source?.executionId ?? "system-" + incident.id,
      taskId: source?.taskId ?? incident.taskId,
      subtaskId: source?.subtaskId ?? incident.subtaskId,
      phase: source?.phase ?? incident.phase,
      level: "info",
      agentId,
      incidentId: incident.id,
      message: `Console recuperado; fila do agente ${agentId} retomada`,
      timestamp: new Date(),
    })
    await this.pump()
    return true
  }

  isAgentQueuePaused(agentId: string): boolean {
    return this.consoleIncidents.has(agentId)
  }

  async onTaskPaused(executionId: string, reason: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    this.logger.info("Tarefa pausada: " + worker.taskId + " - " + reason, { taskId: worker.taskId, executionId })
    // Subtarefa interrompida volta a pendente para o pump retomá-la depois do
    // resume; sem isso ela ficaria órfã em running/verifying para sempre.
    if (worker.subtaskId) {
      await this.db.query(
        "UPDATE subtarefas SET status = 'pending', updated_at = NOW() WHERE id = ? AND status IN ('running', 'verifying', 'delivered', 'rework')",
        [worker.subtaskId],
      ).catch((error: unknown) => this.logger.error("Falha ao resetar subtarefa pausada: " + describeError(error), { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId }))
    }
    await this.db.query(
      "UPDATE tarefas SET paused_at = NOW(), updated_at = NOW() WHERE external_id = ? OR id = CAST(? AS UNSIGNED)",
      [worker.taskId, worker.taskId],
    )
    // Preservar o worktree no pause: trabalho não commitado do dev pode estar lá;
    // limpar destruiria progresso e queimaria tokens no rework.
    await this.finishWorker(executionId, worker, { preserveWorkspace: true })
  }

  /**
   * Analista pediu esclarecimentos: a tarefa entra em `awaiting_clarification`
   * e fica parada aguardando resposta no chat da tarefa. O relógio de timeout
   * deixa de contar naturalmente porque o worker encerrou; o reconciliador de
   * órfãos só toca tarefas `analyzing`/`running`, então este estado sobrevive
   * a boot/reconciliação intacto (quantos dias forem necessários).
   */
  async onTaskClarifying(executionId: string, questionCount: number, summary?: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    try {
      this.publishActivity(worker, {
        type: "clarifying",
        level: "info",
        message: `Analista aguardando esclarecimento (${questionCount} perguntas)`,
      })
      this.logger.info("Análise pausada para clarificação: " + worker.taskId + " (" + questionCount + " perguntas)", {
        taskId: worker.taskId, executionId, phase: "analyze", summary: summary ?? undefined,
      })
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.saveTaskTransition(task, "await_clarification")
      }
    } catch (error) {
      this.logger.error("Falha ao registrar clarificação da tarefa " + worker.taskId + ": " + describeError(error), { taskId: worker.taskId, executionId })
    } finally {
      await this.finishWorker(executionId, worker)
    }
  }

  /**
   * Resposta de clarificação recebida (via API do motor ou via chat da
   * biblioteca). Grava a resposta no chat da tarefa (salvo quando o chamador
   * já a gravou), devolve a tarefa para `planned` e aciona o pump: sem
   * subtarefas persistidas, a tarefa é reenviada para análise com o histórico.
   */
  async answerClarification(taskId: string, texto: string, options?: { jaPersistida?: boolean }): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    const status = await this.facts.derive(taskId, task.status as Task["status"])
    if (status !== "awaiting_clarification") {
      throw new Error("Tarefa " + taskId + " nao esta aguardando esclarecimento (status: " + status + ")")
    }
    const trimmed = texto.trim()
    if (!trimmed) throw new Error("Resposta de esclarecimento vazia")
    if (!options?.jaPersistida) {
      await persistTaskClarificationAnswer(this.db, taskId, trimmed)
    }
    await this.saveTaskTransition(task, "clarification_answered")
    this.logger.info("Resposta de clarificação recebida; tarefa " + taskId + " volta para análise", { taskId })
    await this.pump()
  }

  /**
   * Conciliação de clarificações respondidas (chamada no pump): se a resposta
   * do usuário foi gravada no chat por um caminho que não notificou o motor,
   * detecta aqui e retoma a análise — a retomada não depende de aviso externo.
   */
  private async resumeAnsweredClarifications(): Promise<void> {
    let answered: { taskId: string; texto: string }[] = []
    try {
      answered = await fetchAnsweredTaskClarifications(this.db)
    } catch (error) {
      this.logger.warn("Falha ao conciliar clarificações respondidas: " + describeError(error))
      return
    }
    for (const item of answered) {
      try {
        this.logger.info("Resposta de clarificação detectada no chat da tarefa " + item.taskId + "; retomando análise", { taskId: item.taskId })
        await this.answerClarification(item.taskId, item.texto, { jaPersistida: true })
      } catch (error) {
        this.logger.warn("Falha ao retomar clarificação detectada no chat (" + item.taskId + "): " + describeError(error))
      }
    }
  }

  async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    this.logger.info("Recurso liberado: " + resourceKey)
    await this.waitManager?.resumeNext(resourceKey)
    await this.pump()
  }

  async onLeaseExpired(resourceKey: ResourceKey, executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || worker.resourceKey !== resourceKey) return
    await this.handleWorkerFailure(executionId, `Lease expirado para ${resourceKey}`, "lease_expired")
  }

  getStats() {
    const workers = Array.from(this.activeWorkers.values()).map((worker) => ({
      executionId: worker.executionId,
      taskId: worker.taskId,
      subtaskId: worker.subtaskId ?? null,
      phase: worker.phase,
      executionPhase: worker.executionPhase ?? null,
      projectSlug: worker.projectSlug ?? null,
      startedAt: worker.startedAt.toISOString(),
      ageMs: Date.now() - worker.startedAt.getTime(),
      lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
    }))
    const deployments = Array.from(this.activeDeployments.values()).map((deployment) => ({
      taskId: deployment.taskId,
      phase: deployment.phase,
      startedAt: deployment.startedAt.toISOString(),
      ageMs: Date.now() - deployment.startedAt.getTime(),
    }))
    const activities = [
      ...workers.filter((worker) => worker.executionPhase === "verify").map((worker) => ({ taskId: worker.taskId, phase: "verify" as const })),
      ...deployments.map((deployment) => ({ taskId: deployment.taskId, phase: deployment.phase })),
    ]
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers ?? getConfigNumber('motor.max_workers'),
      maxWorkersPerProject: this.config.maxWorkersPerProject ?? getConfigNumber('motor.max_workers_per_project'),
      workers,
      deployments,
      activities,
      maintenanceOperations: this.activeMaintenance,
    }
  }

  async getDeployDiagnostics(): Promise<{ canStart: boolean; reasons: string[]; pendingRequests: number }> {
    const reasons: string[] = []
    if (this.activeWorkers.size > 0) reasons.push(`${this.activeWorkers.size} worker(s) ativo(s)`)
    if (this.finalizingExecutions.size > 0) reasons.push(`${this.finalizingExecutions.size} execução(ões) finalizando`)
    if (this.activeMaintenance > 0) reasons.push(`${this.activeMaintenance} manutenção(ões) ativa(s)`)
    if (this.activeDeployments.size > 0) reasons.push(`${this.activeDeployments.size} deploy(s) em andamento`)
    const { rows: busyRows } = await this.db.query(
      "SELECT EXISTS(SELECT 1 FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE t.paused_at IS NULL AND f.terminal_status IS NULL AND f.analysis_started_at IS NOT NULL) " +
      "OR EXISTS(SELECT 1 FROM subtarefas WHERE status IN ('running','delivered','verifying')) AS busy",
    )
    const { rows } = await this.db.query("SELECT COUNT(*) AS total FROM deploy_requests WHERE status = 'pending'")
    const pendingRequests = Number(rows[0]?.total ?? 0)
    if (Number(busyRows[0]?.busy ?? 0) !== 0) {
      const { rows: activeRows } = await this.db.query(
        "SELECT DISTINCT COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id " +
        "FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
        "WHERE (t.paused_at IS NULL AND f.terminal_status IS NULL AND f.analysis_started_at IS NOT NULL) " +
        "OR EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status IN ('running','delivered','verifying')) " +
        "ORDER BY task_id LIMIT 10",
      )
      const taskIds = activeRows.map((row) => String(row.task_id)).filter(Boolean)
      reasons.push(taskIds.length > 0 ? `tarefas ativas: ${taskIds.join(', ')}` : "há tarefa ou subtarefa ativa")
    }
    if (pendingRequests > 0 && reasons.length === 0) {
      try {
        this.assertDeploySshReady()
      } catch (error: unknown) {
        reasons.push(`SSH do deploy indisponível: ${describeError(error).substring(0, 300)}`)
      }
    }
    return { canStart: reasons.length === 0 && pendingRequests > 0, reasons: reasons.length ? reasons : [pendingRequests > 0 ? "deploy pronto para iniciar" : "nenhuma solicitação de deploy pendente"], pendingRequests }
  }

  /** Agenda o deploy de uma tarefa concluída. O botão nunca recria a API
   * enquanto há workers ativos. */
  async deployTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " não encontrada")
    if (task.tipo !== "desenvolvimento") throw new Error("Deploy manual é permitido apenas para tarefas de desenvolvimento")
    const status = await this.facts.derive(taskId)
    if (status !== "completed") throw new Error("Deploy manual exige tarefa concluída (status atual: " + status + ")")
    await this.enqueueDeploy(taskId, task.repoPath)
    void this.pump().catch((error: unknown) => this.logger.error("Falha ao avaliar fila de deploy: " + describeError(error), { taskId }))
  }

  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    return this.mapSaveDataToTask({ ...data, status: await this.facts.derive(taskId, data.status as Task["status"]) })
  }

  async getTaskStatusHistory(taskId: string): Promise<Array<{
    previousStatus: string
    nextStatus: string
    source: string
    reason: string | null
    createdAt: string
  }>> {
    const { rows } = await this.db.query(
      "SELECT h.status_anterior, h.status_novo, h.origem, h.motivo, h.created_at " +
      "FROM tarefas_status_historico h INNER JOIN tarefas t ON t.id = h.tarefa_id " +
      "WHERE t.external_id = ? OR t.id = CAST(? AS UNSIGNED) ORDER BY h.id DESC LIMIT 200",
      [taskId, taskId],
    )
    return rows.map((row) => {
      const data = row as Record<string, unknown>
      return {
        previousStatus: String(data.status_anterior),
        nextStatus: String(data.status_novo),
        source: String(data.origem),
        reason: data.motivo ? String(data.motivo) : null,
        createdAt: String(data.created_at),
      }
    })
  }

  /**
   * Tarefa completa com subtarefas e motivo de bloqueio na resposta —
   * remove a dependência do fallback direto no banco pela tela de
   * acompanhamento e dá visibilidade ao motivo de bloqueio.
   */
  async getTaskWithSubtasks(taskId: string): Promise<(Task & { subtasks: SubtaskView[]; errorMessage?: string; ultimoBloqueio: UltimoBloqueio | null; clarificacaoPendente: ClarificacaoPendente | null; promotionConflictAnalysis: PromotionConflictAnalysisView | null }) | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    const task = this.mapSaveDataToTask(data)
    const isNumeric = /^\d+$/.test(taskId)
    const whereTask = isNumeric ? "WHERE (t.external_id = ? OR t.id = ?) " : "WHERE t.external_id = ? "
    const taskParams = isNumeric ? [taskId, taskId] : [taskId]

    const { rows } = await this.db.query(
      "SELECT s.id, s.seq, s.titulo, s.status, s.resultado, s.deliver_count, " +
      "s.workspace_status, s.workspace_branch, s.workspace_commit_sha, s.correction_for_subtask_id " +
      "FROM subtarefas s " +
      "INNER JOIN tarefas t ON t.id = s.tarefa_id " +
      whereTask +
      "ORDER BY s.seq ASC, s.id ASC",
      taskParams,
    )
    const subtasks: SubtaskView[] = rows.map((row) => ({
      id: Number(row.id),
      seq: Number(row.seq),
      titulo: String(row.titulo ?? ""),
      status: String(row.status ?? "pending"),
      resultado: row.resultado ? String(row.resultado) : null,
      deliverCount: Number(row.deliver_count ?? 0),
      workspaceStatus: row.workspace_status ? String(row.workspace_status) : null,
      workspaceBranch: row.workspace_branch ? String(row.workspace_branch) : null,
      workspaceCommitSha: row.workspace_commit_sha ? String(row.workspace_commit_sha) : null,
      correctionForSubtaskId: row.correction_for_subtask_id ? Number(row.correction_for_subtask_id) : null,
      deliveryHistory: [], // será preenchido abaixo
    }))

    // Durante a migração, o valor gravado ainda é usado como compatibilidade
    // para fatos que não possuíam coluna própria (deploy, clarificação e
    // bloqueio). A resposta da API, porém, deixa de aceitar `tarefas.status`
    // como verdade sobre a existência de trabalho pendente ou em execução.
    task.status = await this.facts.derive(taskId, task.status)

    // Busca o histórico de entregas para todas as subtarefas da tarefa
    if (subtasks.length > 0) {
      const subtaskIds = subtasks.map((s) => s.id)
      const placeholders = subtaskIds.map(() => "?").join(", ")
      const { rows: historyRows } = await this.db.query(
        "SELECT id, subtarefa_id, deliver_number, model, event_type, reason, created_at " +
        "FROM subtarefas_entregas " +
        "WHERE subtarefa_id IN (" + placeholders + ") " +
        "ORDER BY subtarefa_id ASC, deliver_number ASC, created_at ASC",
        subtaskIds,
      )
      const historyBySubtaskId = new Map<number, DeliveryHistoryEntry[]>()
      for (const row of historyRows) {
        const subtaskId = Number(row.subtarefa_id)
        if (!historyBySubtaskId.has(subtaskId)) {
          historyBySubtaskId.set(subtaskId, [])
        }
        historyBySubtaskId.get(subtaskId)!.push({
          id: Number(row.id),
          deliverNumber: Number(row.deliver_number),
          model: row.model ? String(row.model) : null,
          eventType: String(row.event_type) as DeliveryHistoryEntry["eventType"],
          reason: row.reason ? String(row.reason) : null,
          createdAt: String(row.created_at),
        })
      }
      for (const subtask of subtasks) {
        subtask.deliveryHistory = historyBySubtaskId.get(subtask.id) ?? []
      }
    }

    // B9 (2026-08-31): o último bloqueio só é exposto enquanto a tarefa ESTÁ
    // bloqueada. Antes o histórico ficava visível para sempre — a tela
    // "Acompanhar Tarefa" mostrava banner ⛔ de bloqueio já resolvido (caso
    // 731, Alexandre). O histórico permanece na tabela para auditoria.
    let ultimoBloqueio: UltimoBloqueio | null = null
    if (task.status === "blocked") {
      const { rows: blockRows } = await this.db.query(
        "SELECT b.block_reason, b.block_excerpt, b.blocked_at, b.subtarefa_id " +
        "FROM bloqueios b " +
        "INNER JOIN tarefas t ON t.id = b.tarefa_id " +
        whereTask +
        "ORDER BY b.blocked_at DESC LIMIT 1",
        taskParams,
      )
      if (blockRows.length > 0) {
        ultimoBloqueio = {
          kind: String(blockRows[0]!.block_reason ?? ""),
          excerpt: String(blockRows[0]!.block_excerpt ?? ""),
          blockedAt: String(blockRows[0]!.blocked_at ?? ""),
          subtaskId: blockRows[0]!.subtarefa_id ? Number(blockRows[0]!.subtarefa_id) : null,
        }
      }
    }

    // Clarificação pendente (analista perguntou e ninguém respondeu ainda):
    // expõe a pergunta e desde quando, para a tela mostrar o que está travando.
    let clarificacaoPendente: ClarificacaoPendente | null = null
    if (task.status === "awaiting_clarification") {
      try {
        const pending = await fetchPendingTaskClarification(this.db, taskId)
        if (pending) clarificacaoPendente = pending
      } catch (error) {
        this.logger.warn("Falha ao buscar clarificação pendente da tarefa " + taskId + ": " + describeError(error), { taskId })
      }
    }

    const { rows: analysisRows } = await this.db.query(
      "SELECT p.status, p.confidence, p.recommendation, p.report, p.error_message, p.conflict_files_json, p.attempts, p.updated_at " +
      "FROM promotion_conflict_analyses p INNER JOIN tarefas t ON t.id = p.tarefa_id " + whereTask +
      "ORDER BY p.created_at DESC LIMIT 1",
      taskParams,
    )
    const analysisRow = analysisRows[0]
    const rawFiles = analysisRow?.conflict_files_json
    const conflictFiles = Array.isArray(rawFiles) ? rawFiles.map(String) : typeof rawFiles === "string" ? JSON.parse(rawFiles) as string[] : []
    const promotionConflictAnalysis: PromotionConflictAnalysisView | null = analysisRow ? {
      status: String(analysisRow.status),
      confidence: analysisRow.confidence ? String(analysisRow.confidence) : null,
      recommendation: analysisRow.recommendation ? String(analysisRow.recommendation) : null,
      report: analysisRow.report ? String(analysisRow.report) : null,
      errorMessage: analysisRow.error_message ? String(analysisRow.error_message) : null,
      conflictFiles,
      attempts: Number(analysisRow.attempts ?? 0),
      updatedAt: String(analysisRow.updated_at ?? ""),
    } : null

    return { ...task, subtasks, errorMessage: data.errorMessage, ultimoBloqueio, clarificacaoPendente, promotionConflictAnalysis }
  }

  private mapSaveDataToTask(data: import("../shared/types/infrastructure.js").SaveTaskData): Task {
    return {
      id: data.id, chatId: data.chatId ?? "", agentId: data.agentId ?? "",
      title: data.title, description: data.description ?? "",
      tipo: data.tipo ?? "desenvolvimento",
      repoPath: data.repoPath ?? "", buildCommand: data.buildCommand ?? "npm run build",
      unitTestCommand: data.unitTestCommand ?? "npm run test", unitTestExclude: [],
      baselineMode: "full", status: data.status as Task["status"],
      maxRework: data.maxRework, hardTimeoutMs: data.hardTimeoutMs,
      dependsOnTaskId: data.dependsOnTaskId, projectSlug: data.projectSlug ?? null,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    }
  }

  async enqueueTask(taskId: string): Promise<{ executionId: string }> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    const status = await this.facts.derive(taskId, task.status as Task["status"])
    if (status !== "planned") {
      throw new Error("Tarefa " + taskId + " esta em status " + status)
    }

    // A FK persistida identifica o projeto operacional. O projeto/tenant do
    // token da Biblioteca pertence a outro namespace e não participa do gate.
    const { rows: taskRows } = await this.db.query(
      "SELECT t.projeto_id FROM tarefas t WHERE t.external_id = ? LIMIT 1",
      [taskId]
    )
    const taskRow = taskRows[0] as Record<string, unknown> | undefined
    const projetoId = taskRow?.projeto_id == null ? NaN : Number(taskRow.projeto_id)
    const isSetupTask = taskId.startsWith("setup-")
    const taskType = isSetupTask ? "setup" as const : "execution" as const

    // A ausência da linha também é erro: não deixar o motor prosseguir com
    // joins nulos e só falhar depois como "Unknown agent id".
    const validation = await validateProjectId(
      projetoId,
      { taskType },
      async (id) => {
        const { rows } = await this.db!.query(
          "SELECT pc.id, pc.slug, pc.agente_id AS agenteId, " +
          "a.openclaw_agent_id AS agenteOpenclawId, a.nome AS agenteNome " +
          "FROM projetos_captados pc LEFT JOIN agentes a ON a.id = pc.agente_id " +
          "WHERE pc.id = ? LIMIT 1",
          [id],
        )
        const row = rows[0] as Record<string, unknown> | undefined
        return row ? {
          id: Number(row.id), slug: String(row.slug),
          agenteId: row.agenteId == null ? null : Number(row.agenteId),
          agenteOpenclawId: row.agenteOpenclawId ? String(row.agenteOpenclawId) : null,
          agenteNome: row.agenteNome ? String(row.agenteNome) : null,
        } : null
      },
    )
    if (!validation.ok) {
      throw new Error(formatProjectIdValidationReport(validation))
    }
    this.logger.info("Validação de projeto_id OK: " + formatProjectIdValidationReport(validation), {
      taskId, projetoId, projectSlug: validation.projectSlug,
    })

    // Verificação do agente no gateway antes de enfileirar (item 6 do plano de controles).
    // Tarefa de projeto novo só é enfileirada com agente confirmado no gateway.
    // Tarefas de setup (executadas pela biblioteca) não precisam dessa verificação.
    if (taskType === 'execution') {
      const agentId = task.agentId || (validation.agentId ?? null)
      const agentVerification = await this.verifyAgentBeforeEnqueue(agentId)
      if (shouldBlockEnqueue(agentVerification)) {
        const report = formatAgentVerificationReport(agentVerification)
        this.logger.warn("Enqueue bloqueado: agente não confirmado no gateway", {
          taskId,
          agentId,
          projectSlug: task.projectSlug ?? undefined,
          failureKind: agentVerification.failureKind,
        })
        // Persiste bloqueio auditável
        try {
          await this.persistTaskBlock(
            task.id,
            null,
            "agent_not_in_gateway",
            "motor-v2:gateway-agent-verification",
            agentVerification.reason ?? report,
          )
        } catch (persistError) {
          this.logger.error("Falha ao persistir bloqueio de verificação de agente: " + describeError(persistError), { taskId })
        }
        throw new Error(report)
      }
      this.logger.info("Verificação de agente OK: " + formatAgentVerificationReport(agentVerification), {
        taskId,
        agentId,
      })
    }

    await this.pump()
    return { executionId: "exec-" + task.id + "-" + Date.now() }
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    
    // Verifica se há worker ativo para esta tarefa
    let workerAtivo = false
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      if (worker.taskId === taskId) {
        // Pause graceful: marca para pausar após terminar a fase atual
        worker.pendingPause = true
        workerAtivo = true
        this.logger.info("Pause graceful agendado: worker terminará fase atual antes de pausar", {
          taskId,
          executionId,
          phase: worker.phase
        })
        break
      }
    }
    
    // Se não há worker ativo, pausa imediatamente — em transação com lock de
    // linha para não correr com resumeNext (liberação de recurso concorrente
    // poderia desfazer o pause entre o DELETE da fila e o UPDATE da tarefa).
    if (!workerAtivo) {
      await this.db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1 FOR UPDATE",
          [taskId, taskId]
        )
        await tx.query(
          "DELETE q FROM execution_resource_queue q " +
          "INNER JOIN tarefas t ON t.resource_wait_id = q.id " +
          "WHERE (t.external_id = ? OR t.id = CAST(? AS UNSIGNED)) AND q.status = 'waiting'",
          [taskId, taskId]
        )
        // Se o processo foi reiniciado, não há worker em memória para chamar
        // onTaskPaused(). As subtarefas que ficaram em estado operacional
        // precisam voltar a pending; caso contrário a tarefa parece pausada,
        // mas não encontra trabalho retomável depois do resume. O worktree é
        // mantido: apenas o estado do agendamento é reparado.
        await tx.query(
          "UPDATE subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id " +
          "SET s.status = 'pending', s.updated_at = NOW() " +
          "WHERE (t.external_id = ? OR t.id = CAST(? AS UNSIGNED)) " +
          "AND s.status IN ('running', 'verifying', 'delivered', 'rework')",
          [taskId, taskId]
        )
        await tx.query(
          "UPDATE tarefas SET paused_at = NOW(), resource_wait_key = NULL, resource_wait_id = NULL, resource_wait_position = NULL, updated_at = NOW() " +
          "WHERE external_id = ? OR id = CAST(? AS UNSIGNED)",
          [taskId, taskId]
        )
      })
      this.logger.info("Tarefa pausada imediatamente (sem worker ativo)", { taskId })
    }
  }

  async resumeTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    const { rows } = await this.db.query(
      "SELECT paused_at FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1",
      [taskId, taskId],
    )
    if (!rows[0]?.paused_at) throw new Error("Tarefa " + taskId + " nao esta pausada")
    await this.db.query(
      "UPDATE tarefas SET paused_at = NULL, updated_at = NOW() WHERE external_id = ? OR id = CAST(? AS UNSIGNED)",
      [taskId, taskId],
    )
    await this.pump()
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    const status = await this.facts.derive(taskId)
    if (status === "completed" || status === "cancelled") {
      throw new Error("Tarefa " + taskId + " ja esta " + status)
    }
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      if (worker.taskId === taskId) {
        await this.workerLauncher.stopWorker(executionId)
        if (this.beginFinalization(executionId, worker)) await this.finishWorker(executionId, worker)
        break
      }
    }
    await this.saveTaskTransition(task, "cancel")
    // Tarefa cancelada: purgar worktrees/branches residuais
    if (task.repoPath) this.purgeTaskArtifactsFireAndForget(taskId, task.repoPath)
    await this.pump()
  }

  /**
   * Purga worktrees/branches de tarefa terminal sem bloquear o fluxo.
   * Acumulo de a1/a2/a3... consome disco; limpar após completion/cancel.
   */
  private purgeTaskArtifactsFireAndForget(taskId: string, repoPath: string): void {
    this.activeMaintenance += 1
    void this.workspaceManager.purgeTaskArtifacts({ repoPath, taskId }).then((result) => {
      if (result.worktreesRemoved > 0 || result.branchesRemoved > 0) {
        this.logger.info(`Purga de artefatos: taskId=${taskId}, worktrees=${result.worktreesRemoved}, branches=${result.branchesRemoved}`)
      }
    }).catch((error: unknown) => {
      this.logger.warn("Falha ao purgar artefatos da tarefa " + taskId + ": " + describeError(error))
    }).finally(() => {
      this.activeMaintenance = Math.max(0, this.activeMaintenance - 1)
      void this.pump().catch((error: unknown) => this.logger.error("Falha ao avaliar fila após manutenção: " + describeError(error), { taskId }))
    })
  }

  private async enqueueDeploy(taskId: string, repoPath: string): Promise<void> {
    await this.db.query(
      "INSERT INTO deploy_requests (tarefa_id, repo_path, status, requested_at, updated_at) " +
      "SELECT id, ?, 'pending', NOW(), NOW() FROM tarefas WHERE external_id = ? OR CAST(id AS CHAR) = ? " +
      "ON DUPLICATE KEY UPDATE repo_path = VALUES(repo_path), status = IF(status = 'running', status, 'pending'), " +
      "batch_id = IF(status = 'running', batch_id, NULL), last_error = NULL, requested_at = NOW(), updated_at = NOW()",
      [repoPath, taskId, taskId],
    )
    this.logger.info("Deploy agendado", { taskId, repoPath })
  }

  /** Concilia um lote que sobreviveu à recriação da API e, quando o Motor está
   * totalmente ocioso, inicia no máximo um lote por repositório. */
  private async processDeployQueue(): Promise<void> {
    // Guarda de reentrância: processDeployQueue roda FORA do guarda `pumping`
    // (é chamado após o finally do pump). Sem esta flag, dois pumps sobrepostos
    // poderiam despachar o mesmo lote de deploy duas vezes.
    if (this.processingDeployQueue) return
    this.processingDeployQueue = true
    try {
      await this.processDeployQueueInner()
    } finally {
      this.processingDeployQueue = false
    }
  }

  private async processDeployQueueInner(): Promise<void> {
    await this.reconcileRunningDeploys()
    await this.reconcileCompletedTasksAlreadyMerged()
    await this.recoverCompletedTasksWithoutDeploy()
    if (this.activeWorkers.size > 0 || this.finalizingExecutions.size > 0 || this.activeMaintenance > 0 || this.activeDeployments.size > 0) return
    // Verifica se há tarefas ativas usando fatos operacionais (status é derivado)
    const { rows: busyRows } = await this.db.query(
      "SELECT EXISTS(SELECT 1 FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE t.paused_at IS NULL AND f.terminal_status IS NULL AND f.analysis_started_at IS NOT NULL) " +
      "OR EXISTS(SELECT 1 FROM subtarefas WHERE status IN ('running','delivered','verifying')) AS busy",
    )
    if (Number(busyRows[0]?.busy ?? 0) !== 0) return

    const { rows } = await this.db.query(
      "SELECT dr.id, dr.repo_path, COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id FROM deploy_requests dr " +
      "INNER JOIN tarefas t ON t.id = dr.tarefa_id WHERE dr.status = 'pending' ORDER BY dr.requested_at ASC",
    )
    if (rows.length === 0) return
    const repoPath = String(rows[0]!.repo_path)
    const batchRows = rows.filter((row) => String(row.repo_path) === repoPath)
    const taskIds = batchRows.map((row) => String(row.task_id))
    const requestIds = batchRows.map((row) => Number(row.id))
    // Confirma a identidade do ServerIA ANTES de marcar as solicitações como
    // running. Assim uma chave SSH alterada não bloqueia em massa tarefas que
    // já concluíram o desenvolvimento e só aguardam publicação.
    try {
      this.assertDeploySshReady()
    } catch (error: unknown) {
      const message = describeError(error).substring(0, 500)
      const placeholders = requestIds.map(() => "?").join(",")
      await this.db.query(
        `UPDATE deploy_requests SET last_error = ?, updated_at = NOW() WHERE status = 'pending' AND id IN (${placeholders})`,
        [message, ...requestIds],
      )
      this.logger.warn("Preflight de deploy falhou; lote mantido pendente: " + message, { taskIds })
      return
    }
    const batchId = "deploy-" + randomUUID()
    const placeholders = requestIds.map(() => "?").join(",")
    // Reivindica o lote atomicamente: se affectedRows = 0, outro processamento
    // concorrente (ou instância) já marcou estas solicitações como running.
    const claimResult = await this.db.query(
      `UPDATE deploy_requests SET status = 'running', batch_id = ?, started_at = NOW(), finished_at = NULL, last_error = NULL, updated_at = NOW() WHERE status = 'pending' AND id IN (${placeholders})`,
      [batchId, ...requestIds],
    )
    if ((claimResult.affectedRows ?? 0) === 0) {
      this.logger.info("Lote de deploy já reivindicado por outro processamento; ignorando", { batchId, taskIds })
      return
    }
    const startedAt = new Date()
    for (const taskId of taskIds) this.activeDeployments.set(taskId, { taskId, phase: "verify", startedAt })
    try {
      this.dispatchDeployBatch(repoPath, batchId, taskIds)
      for (const taskId of taskIds) {
        const deployment = this.activeDeployments.get(taskId)
        if (deployment) deployment.phase = "deploy"
      }
    } catch (error: unknown) {
      const message = describeError(error).substring(0, 500)
      await this.failDeployBatch(batchId, message, taskIds)
      this.logger.error("Falha ao disparar lote de deploy: " + message, { batchId, taskIds })
    }
  }

  /**
   * Reconcilia tarefas antigas que já chegaram à base, mas não possuem o fato
   * de deploy persistido. A ancestralidade Git é a evidência; não confiamos
   * apenas no status materializado da tarefa.
   */
  private async reconcileCompletedTasksAlreadyMerged(): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT t.id, COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id, pmc.repo_path, pmc.branch_trabalho AS base_branch " +
      "FROM tarefas t INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id " +
      "INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id AND f.integration_confirmed_at IS NOT NULL " +
      "WHERE t.tipo = 'desenvolvimento' AND f.terminal_status IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) " +
      "AND NOT EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded')) " +
      "AND pmc.repo_path IS NOT NULL AND pmc.repo_path <> ''",
    )
    for (const row of rows) {
      const taskId = String(row.task_id)
      const repoPath = String(row.repo_path)
      const baseBranch = String(row.base_branch || "base-desenvolvimento")
      const taskBranch = taskIntegrationBranch(taskId)
      if (!(await this.workspaceManager.isBranchAncestor({ repoPath, branch: taskBranch, ancestor: baseBranch }))) continue
      await this.db.query(
        "INSERT INTO deploy_requests (tarefa_id, repo_path, status, batch_id, last_error, requested_at, started_at, finished_at, updated_at) " +
        "VALUES (?, ?, 'succeeded', ?, ?, NOW(), NOW(), NOW(), NOW()) " +
        "ON DUPLICATE KEY UPDATE status = 'succeeded', batch_id = VALUES(batch_id), last_error = VALUES(last_error), started_at = VALUES(started_at), finished_at = VALUES(finished_at), updated_at = NOW()",
        [Number(row.id), repoPath, `reconciled-${Date.now()}-${Number(row.id)}`, "reconciliado: branch já estava mergeada na base"],
      )
      this.logger.info("Tarefa concluída reconciliada como deployada: branch já estava na base", { taskId, taskBranch, baseBranch })
    }
  }

  /** Atualiza as branches de integração das tarefas ainda não concluídas. */
  private async synchronizeOngoingTaskBranches(): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT DISTINCT t.id, COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id, pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho AS base_branch " +
      "FROM tarefas t INNER JOIN projetos_captados pc ON pc.id = t.projeto_id " +
      "INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id " +
      "INNER JOIN subtarefas s ON s.tarefa_id = t.id " +
      "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE t.tipo = 'desenvolvimento' AND COALESCE(f.terminal_status, '') NOT IN ('failed', 'cancelled') " +
      "AND s.status NOT IN ('verified', 'superseded') " +
      "AND NOT EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') " +
      "AND pmc.repo_path IS NOT NULL AND pmc.repo_path <> ''",
    )
    for (const row of rows) {
      const taskId = String(row.task_id)
      const taskBranch = taskIntegrationBranch(taskId)
      const projectSlug = String(row.project_slug || "")
      const sync = async () => this.workspaceManager.mergeBaseIntoTaskBranch({
        repoPath: String(row.repo_path),
        baseBranch: String(row.base_branch || "base-desenvolvimento"),
        taskBranch,
      })
      try {
        const result = projectSlug
          ? await this.withProjectIntegrationLock(projectSlug, `deploy-sync-${randomUUID()}`, taskId, sync)
          : await sync()
        if (result.kind === "merged") this.logger.info("Branch de integração atualizada com a base após deploy", { taskId, taskBranch, mergeCommit: result.mergeCommit })
      } catch (error: unknown) {
        const reason = `Sincronização da branch de integração após deploy falhou: ${describeError(error)}`
        await this.db.query(
          "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
          "SELECT id, NULL, 'systemic_failure', ?, ?, NOW() FROM tarefas WHERE id = ? " +
          "AND NOT EXISTS (SELECT 1 FROM bloqueios WHERE tarefa_id = ? AND block_command = ? AND resolved_at IS NULL)",
          [`motor-v2:base-sync:${encodeURIComponent(taskBranch)}`, reason.substring(0, 500), Number(row.id), Number(row.id), `motor-v2:base-sync:${encodeURIComponent(taskBranch)}`],
        )
        this.logger.warn(reason, { taskId, taskBranch })
      }
    }
  }

  /** Recuperação de boot/pump: uma queda entre a conclusão da tarefa e a
   * criação da solicitação não pode deixar desenvolvimento sem publicação. */
  private async recoverCompletedTasksWithoutDeploy(): Promise<void> {
    const result = await this.db.query(
      "INSERT INTO deploy_requests (tarefa_id, repo_path, status, requested_at, updated_at) " +
      "SELECT t.id, pmc.repo_path, 'pending', NOW(), NOW() FROM tarefas t " +
      "INNER JOIN projetos_captados pc ON pc.id = t.projeto_id " +
      "INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "LEFT JOIN deploy_requests dr ON dr.tarefa_id = t.id " +
      "INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id AND f.integration_confirmed_at IS NOT NULL " +
      "WHERE t.tipo = 'desenvolvimento' AND f.terminal_status IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded')) " +
      "AND pmc.repo_path IS NOT NULL AND pmc.repo_path <> '' AND dr.id IS NULL",
    )
    if ((result.affectedRows ?? 0) > 0) {
      this.logger.info("Deploys ausentes recuperados para tarefas concluídas", { count: result.affectedRows })
    }
  }

  private dispatchDeployBatch(repoPath: string, batchId: string, taskIds: string[]): void {
    const repoRoot = execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
    const relativeScript = "projects/gerenteagentes/motor-v2/scripts/deploy-host.sh"
    if (!existsSync(join(repoRoot, relativeScript))) throw new Error("deploy-host.sh não encontrado na raiz Git " + repoRoot)
    const hostRepoRoot = process.env.DEPLOY_REPO_HOST ?? "/home/alexandre/codigofonte/biblioteca-global"
    const hostDeployScript = hostRepoRoot + "/" + relativeScript
    const safeBatchId = batchId.replace(/[^a-zA-Z0-9_-]/g, "_")
    const logFile = "/tmp/biblioteca-global-" + safeBatchId + ".log"
    const statusFile = "/tmp/biblioteca-global-" + safeBatchId + ".status"
    const run = "bash " + shellQuote(hostDeployScript) + " " + shellQuote(hostRepoRoot)
    const wrapped = "(" + run + "; code=$?; if [ $code -eq 0 ]; then printf success; else printf 'failed:%s' $code; fi > " + shellQuote(statusFile) + ")"
    const remoteCommand = "nohup bash -lc " + shellQuote(wrapped) + " > " + shellQuote(logFile) + " 2>&1 < /dev/null & echo $!"
    const output = execFileSync("ssh", this.deploySshArguments(remoteCommand), { encoding: "utf8", timeout: 15_000 }).trim()
    if (!/^\d+$/.test(output)) throw new Error("SSH não confirmou o PID do deploy destacado: " + output)
    this.logger.info("Lote de deploy destacado no ServerIA", { batchId, taskIds, remotePid: output, logFile, statusFile })
  }

  private async reconcileRunningDeploys(): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT dr.batch_id, dr.started_at, COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id FROM deploy_requests dr " +
      "INNER JOIN tarefas t ON t.id = dr.tarefa_id WHERE dr.status = 'running' ORDER BY dr.started_at ASC",
    )
    const batches = new Map<string, { taskIds: string[]; startedAt: Date }>()
    for (const row of rows) {
      const batchId = String(row.batch_id || "")
      if (!batchId) continue
      const batch = batches.get(batchId) ?? { taskIds: [], startedAt: new Date(String(row.started_at)) }
      batch.taskIds.push(String(row.task_id))
      batches.set(batchId, batch)
    }
    for (const [batchId, batch] of batches) {
      for (const taskId of batch.taskIds) this.activeDeployments.set(taskId, { taskId, phase: "deploy", startedAt: batch.startedAt })
      const status = this.readRemoteDeployStatus(batchId)
      if (!status) {
        if (Date.now() - batch.startedAt.getTime() > 30 * 60_000) {
          await this.failDeployBatch(batchId, "processo remoto não produziu resultado em 30 minutos", batch.taskIds)
          for (const taskId of batch.taskIds) this.activeDeployments.delete(taskId)
        }
        continue
      }
      if (status === "success") {
        await this.db.query("UPDATE deploy_requests SET status = 'succeeded', finished_at = NOW(), updated_at = NOW() WHERE batch_id = ? AND status = 'running'", [batchId])
        this.logger.info("Lote de deploy confirmado", { batchId, taskIds: batch.taskIds })
        await this.synchronizeOngoingTaskBranches()
      } else {
        await this.failDeployBatch(batchId, status, batch.taskIds)
      }
      for (const taskId of batch.taskIds) this.activeDeployments.delete(taskId)
    }
  }

  private readRemoteDeployStatus(batchId: string): string | null {
    const safeBatchId = batchId.replace(/[^a-zA-Z0-9_-]/g, "_")
    const statusFile = "/tmp/biblioteca-global-" + safeBatchId + ".status"
    const command = "if [ -f " + shellQuote(statusFile) + " ]; then cat " + shellQuote(statusFile) + "; fi"
    const output = execFileSync("ssh", this.deploySshArguments(command), { encoding: "utf8", timeout: 15_000 }).trim()
    return output || null
  }

  /** Falha cedo e sem alterar tarefas quando o SSH do deploy não é confiável. */
  private assertDeploySshReady(): void {
    try {
      execFileSync("ssh", this.deploySshArguments("true"), { encoding: "utf8", timeout: 15_000, stdio: "pipe" })
    } catch {
      throw new Error("SSH do deploy não confiável ou indisponível; atualize a identidade do ServerIA antes de iniciar o lote")
    }
  }

  private deploySshArguments(remoteCommand: string): string[] {
    return [
      "-i", "/root/.ssh/id_ed25519",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/root/.ssh/known_hosts",
      "-o", "ConnectTimeout=10",
      "alexandre@192.168.1.8",
      remoteCommand,
    ]
  }

  private async failDeployBatch(batchId: string, error: string, taskIds: string[]): Promise<void> {
    await this.db.query("UPDATE deploy_requests SET status = 'failed', last_error = ?, finished_at = NOW(), updated_at = NOW() WHERE batch_id = ? AND status = 'running'", [error, batchId])
    await this.db.query(
      "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
      "SELECT dr.tarefa_id, NULL, 'deploy_failed', ?, ?, NOW() FROM deploy_requests dr WHERE dr.batch_id = ?",
      ["motor-v2:deploy:" + batchId, error.substring(0, 500), batchId],
    )
    for (const taskId of taskIds) this.activeDeployments.delete(taskId)
  }

  private beginFinalization(executionId: string, worker: ActiveWorker): boolean {
    if (this.finalizingExecutions.has(executionId)) return false
    this.finalizingExecutions.add(executionId)
    if (worker.timeoutHandle) {
      clearTimeout(worker.timeoutHandle)
      worker.timeoutHandle = undefined
    }
    if (worker.silenceHandle) {
      clearTimeout(worker.silenceHandle)
      worker.silenceHandle = undefined
    }
    return true
  }

  private armWorkerTimeout(executionId: string, taskTimeoutMs: number): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    const timeoutMs = this.config.workerTimeoutMs ?? taskTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return

    worker.timeoutHandle = setTimeout(() => {
      this.handleWorkerFailure(
        executionId,
        `Worker excedeu o timeout de ${timeoutMs}ms`,
        "timeout",
      ).catch((error: unknown) => {
        this.logger.error("Falha ao processar timeout do worker: " + describeError(error), { executionId })
      })
    }, timeoutMs)
    this.armSilenceWatchdog(executionId)
  }

  private armSilenceWatchdog(executionId: string): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    const silenceMs = getConfigNumber('motor.worker_silence_timeout_ms')
    worker.lastHeartbeatAt = new Date()
    if (worker.silenceHandle) clearTimeout(worker.silenceHandle)
    worker.silenceHandle = setTimeout(() => {
      this.handleWorkerFailure(executionId, "Worker sem heartbeat por " + silenceMs + "ms", "lost").catch((error: unknown) => {
        this.logger.error("Falha ao processar silence watchdog: " + describeError(error), { executionId })
      })
    }, silenceMs)
  }

  private async handleWorkerFailure(executionId: string, reason: string, kind = "worker_failure"): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || this.finalizingExecutions.has(executionId)) return

    this.logger.warn("Encerrando worker: " + executionId + " - " + reason, { executionId })
    try {
      await this.workerLauncher.stopWorker(executionId, 5000)
    } catch (error) {
      this.logger.error("Falha ao encerrar worker " + executionId + ": " + describeError(error), { executionId })
      this.workerLauncher.killWorker(executionId)
    }
    await this.onTaskFailed(executionId, reason, kind)
  }

  /**
   * Lock de integração por projeto: serializa operações que tocam o working tree
   * do repositório principal (git switch + merge + push da promoção da branch da
   * tarefa). Usa lease persistido no banco (tryAcquire sem fila + retry), então
   * protege inclusive se houver mais de uma instância do motor no futuro.
   */
  private async withProjectIntegrationLock<T>(
    projectSlug: string,
    executionId: string,
    ownerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const leaseKey = RESOURCE_KEYS.projectIntegration(projectSlug)
    let fencingToken: number | null = null
    const maxAttempts = 150 // ~5 minutos com espera de 2s
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.resourceLease.tryAcquire(leaseKey, executionId, ownerId)
      if (result.kind === "acquired") {
        fencingToken = result.lease.fencingToken
        break
      }
      if (result.kind === "denied") {
        throw new Error("Falha ao adquirir lock de integração do projeto " + projectSlug + ": " + result.reason)
      }
      if (attempt === 0) {
        this.logger.info("Aguardando lock de integração do projeto: " + projectSlug, { executionId })
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (fencingToken === null) {
      throw new Error("Timeout adquirindo lock de integração do projeto " + projectSlug)
    }
    try {
      return await fn()
    } finally {
      const release = await this.resourceLease.release(leaseKey, executionId, fencingToken).catch((error: unknown) => {
        this.logger.warn("Falha ao liberar lock de integração: " + describeError(error), { projectSlug, executionId })
        return { kind: "not_found" as const }
      })
      if (release.kind === "not_found") {
        this.logger.warn("Lock de integração não encontrado na liberação (lease expirado?)", { projectSlug, executionId })
      }
    }
  }

  private async finishWorker(executionId: string, worker: ActiveWorker, options?: { preserveWorkspace?: boolean }): Promise<void> {
    if (worker.timeoutHandle) {
      clearTimeout(worker.timeoutHandle)
      worker.timeoutHandle = undefined
    }
    this.clearActiveExecutionHeartbeat(executionId)
    const preserveWorkspace = options?.preserveWorkspace === true
    try {
      if (worker.workspace && worker.repoPath && !preserveWorkspace) {
        await this.workspaceManager.cleanup({ repoPath: worker.repoPath, workspacePath: worker.workspace.path })
        await this.db.query(
          "UPDATE subtarefas SET workspace_cleaned_at = NOW() WHERE id = ?",
          [worker.subtaskId],
        )
      }
    } catch (error) {
      this.logger.error("Falha ao limpar workspace " + executionId + ": " + describeError(error), { executionId, subtaskId: worker.subtaskId })
      if (worker.subtaskId) {
        await this.db.query(
          "UPDATE subtarefas SET workspace_status = 'cleanup_failed', resultado = ? WHERE id = ?",
          [String(error).substring(0, 500), worker.subtaskId],
        ).catch((dbError: unknown) => this.logger.error("Falha ao registrar limpeza: " + describeError(dbError), { executionId, subtaskId: worker.subtaskId }))
      }
    } finally {
      try {
        if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
      } finally {
        await this.removeActiveExecution(executionId)
        this.activeWorkers.delete(executionId)
        this.finalizingExecutions.delete(executionId)
        await this.pump()
      }
    }
  }

  private activeExecutionExpiry(): Date {
    return new Date(Date.now() + getConfigNumber("motor.worker_silence_timeout_ms"))
  }

  private async registerActiveExecution(
    executionId: string,
    taskId: string,
    subtaskId: number | null,
    phase: ActiveWorker["phase"],
    db: import("../shared/types/infrastructure.js").Db = this.db,
  ): Promise<void> {
    await db.query(
      "INSERT INTO motor_active_executions (execution_id, tarefa_id, subtarefa_id, phase, started_at, heartbeat_at, expires_at) " +
      "SELECT ?, t.id, ?, ?, NOW(), NOW(), ? FROM tarefas t " +
      "WHERE t.external_id = ? OR t.id = CAST(? AS UNSIGNED) LIMIT 1 " +
      "ON DUPLICATE KEY UPDATE heartbeat_at = NOW(), expires_at = VALUES(expires_at)",
      [executionId, subtaskId, phase, this.activeExecutionExpiry(), taskId, taskId],
    )
  }

  private async heartbeatActiveExecution(executionId: string): Promise<void> {
    await this.db.query(
      "UPDATE motor_active_executions SET heartbeat_at = NOW(), expires_at = ? WHERE execution_id = ?",
      [this.activeExecutionExpiry(), executionId],
    )
  }

  private armActiveExecutionHeartbeat(executionId: string): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || worker.presenceHeartbeatHandle) return
    const silenceMs = getConfigNumber("motor.worker_silence_timeout_ms")
    const intervalMs = Math.max(1000, Math.min(30000, Math.floor(silenceMs / 3)))
    worker.presenceHeartbeatHandle = setInterval(() => {
      void this.heartbeatActiveExecution(executionId).catch((error: unknown) => {
        this.logger.error("Falha ao manter presença da execução: " + describeError(error), { executionId })
      })
    }, intervalMs)
    worker.presenceHeartbeatHandle.unref?.()
  }

  private clearActiveExecutionHeartbeat(executionId: string): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker?.presenceHeartbeatHandle) return
    clearInterval(worker.presenceHeartbeatHandle)
    worker.presenceHeartbeatHandle = undefined
  }

  private async removeActiveExecution(executionId: string): Promise<void> {
    await this.db.query("DELETE FROM motor_active_executions WHERE execution_id = ?", [executionId])
      .catch((error: unknown) => this.logger.warn("Falha ao remover presença da execução: " + describeError(error), { executionId }))
  }

  /**
   * Recuperação de worker que saiu com code 0 sem o evento completed/clarifying
   * ter sido processado (perda/atraso de mensagem IPC). Verifica o estado no
   * banco: se a entrega foi registrada (subtarefa verified / plano persistido /
   * clarificação pendente), retoma o fluxo correto em vez de falhar a tarefa.
   */
  private async recoverSilentCodeZeroExit(executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || this.finalizingExecutions.has(executionId)) return

    let action: "complete" | "clarify" | "fail" = "fail"
    let recoveredSha: string | undefined
    try {
      if (worker.phase === "execute" && worker.subtaskId) {
        const { rows } = await this.db.query(
          "SELECT status FROM subtarefas WHERE id = ?",
          [worker.subtaskId],
        )
        const status = String(rows[0]?.status ?? "")
        if (status === "verified" || status === "delivered") {
          // Entrega registrada pelo worker. Recupera o commit da branch do
          // worktree (o worker publica a branch antes de sair) para que a
          // integração na branch da tarefa possa prosseguir normalmente.
          recoveredSha = this.readBranchCommitSha(worker)
          action = recoveredSha ? "complete" : "fail"
        }
      } else if (worker.phase === "analyze") {
        const { rows } = await this.db.query(
          "SELECT s.id FROM subtarefas s INNER JOIN tarefas t ON s.tarefa_id = t.id " +
          "WHERE (t.external_id = ? OR t.id = CAST(? AS UNSIGNED)) LIMIT 1",
          [worker.taskId, worker.taskId],
        )
        if (rows.length > 0) {
          // Plano persistido pelo worker antes do exit: análise concluída.
          action = "complete"
        } else {
          const pending = await fetchPendingTaskClarification(this.db, worker.taskId)
          if (pending) action = "clarify"
        }
      }
    } catch (error) {
      this.logger.warn("Falha ao verificar estado no banco para worker code 0: " + describeError(error), { executionId })
    }

    // O estado pode ter mudado durante as consultas (evento completed chegou
    // atrasado e já iniciou a finalização)
    if (this.finalizingExecutions.has(executionId) || !this.activeWorkers.has(executionId)) return

    if (action === "complete") {
      this.logger.warn("Worker saiu com code 0 sem completed; banco confirma entrega — processando conclusão", {
        executionId, taskId: worker.taskId, subtaskId: worker.subtaskId,
      })
      await this.onTaskCompleted(executionId, {
        ok: true,
        reason: "Recuperado após worker exit code 0 sem evento completed",
        ...(recoveredSha ? { gitCommitSha: recoveredSha } : {}),
      })
      return
    }
    if (action === "clarify") {
      this.logger.warn("Worker saiu com code 0 sem clarifying; banco confirma clarificação pendente — registrando", { executionId, taskId: worker.taskId })
      await this.onTaskClarifying(executionId, 0)
      return
    }
    const reason = "Worker encerrou sem enviar o evento completed"
    this.logger.error(reason + ": " + executionId, { executionId })
    await this.onTaskFailed(executionId, reason, "worker_exit")
  }

  /** Lê o commit da branch do worktree da subtarefa (melhor esforço). */
  private readBranchCommitSha(worker: ActiveWorker): string | undefined {
    if (!worker.workspace) return undefined
    try {
      const sha = execFileSync(
        "git",
        ["rev-parse", "--verify", worker.workspace.branch],
        { cwd: worker.workspace.path, encoding: "utf8" },
      ).trim()
      return /^[a-f0-9]{7,40}$/.test(sha) ? sha : undefined
    } catch {
      return undefined
    }
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on("completed", async (msg: { executionId: string; result: ExecutionResult }) => {
      try {
        await this.onTaskCompleted(msg.executionId, msg.result)
      } catch (error) {
        this.logger.error("Falha ao processar completed: " + describeError(error), { executionId: msg.executionId })
      }
    })
    this.workerLauncher.on("failed", async (msg: { executionId: string; error: string; sessionFailure?: RemoteSessionFailure }) => {
      try {
        await this.onTaskFailed(msg.executionId, msg.error, "error", msg.sessionFailure)
      } catch (error) {
        this.logger.error("Falha ao processar failed: " + describeError(error), { executionId: msg.executionId })
      }
    })
    this.workerLauncher.on("clarifying", async (msg: { executionId: string; questionCount: number; summary?: string }) => {
      try {
        await this.onTaskClarifying(msg.executionId, msg.questionCount, msg.summary)
      } catch (error) {
        this.logger.error("Falha ao processar clarifying: " + describeError(error), { executionId: msg.executionId })
      }
    })
    this.workerLauncher.on("heartbeat", (msg: { executionId: string }) => {
      const worker = this.activeWorkers.get(msg.executionId)
      if (!worker) return
      worker.lastHeartbeatAt = new Date()
      this.armSilenceWatchdog(msg.executionId)
      this.publishActivity(worker, { type: "heartbeat" })
      void this.heartbeatActiveExecution(msg.executionId).catch((error: unknown) => {
        this.logger.error("Falha ao persistir heartbeat: " + describeError(error), { executionId: msg.executionId })
      })
      if (!worker.resourceKey) return
      void this.resourceLease.renew(worker.resourceKey, msg.executionId, worker.fencingToken).then((result) => {
        if (result.kind === "lost") {
          this.logger.warn("Lease perdido: " + msg.executionId + " - " + result.reason, { executionId: msg.executionId })
          this.handleWorkerFailure(msg.executionId, "Lease perdido: " + result.reason, "lease_lost").catch((err: unknown) => {
            this.logger.error("Falha ao processar lease perdido: " + describeError(err), { executionId: msg.executionId })
          })
        }
      }).catch((error: unknown) => {
        this.logger.error("Falha ao renovar lease: " + msg.executionId + ": " + describeError(error), { executionId: msg.executionId })
      })
    })
    this.workerLauncher.on("worker_exit", (event: { executionId: string; code: number | null }) => {
      // Verifica se a execução já está em processo de finalização
      // (race condition: o worker pode exit após enviar "completed" mas antes
      // do finishWorker remover do activeWorkers)
      if (this.finalizingExecutions.has(event.executionId)) {
        this.logger.info("Worker exit durante finalização (esperado): " + event.executionId, { executionId: event.executionId })
        return
      }
      if (!this.activeWorkers.has(event.executionId)) return
      if (event.code === 0) {
        // Code 0 sem completed: o worker só sai com code 0 após enviar completed
        // ou clarifying (com delay de 1s). Antes de declarar falha, verifica o
        // estado no banco — se a entrega/clarificação foi registrada, recupera
        // o fluxo de conclusão em vez de falhar a tarefa.
        void this.recoverSilentCodeZeroExit(event.executionId).catch((error: unknown) => {
          this.logger.error("Falha ao recuperar worker code 0: " + describeError(error), { executionId: event.executionId })
        })
        return
      }
      const reason = "Worker encerrado inesperadamente (codigo " + String(event.code) + ")"
      this.logger.error(reason + ": " + event.executionId, { executionId: event.executionId })
      void this.onTaskFailed(event.executionId, reason, "worker_exit").catch((error: unknown) => {
        this.logger.error("Falha ao persistir encerramento do worker: " + describeError(error), { executionId: event.executionId })
      })
    })
    this.workerLauncher.on("worker_error", (event: { executionId: string; error: Error }) => {
      const reason = "Erro no worker: " + event.error.message
      this.logger.error(reason + ": " + event.executionId, { executionId: event.executionId })
      void this.onTaskFailed(event.executionId, reason).catch((error: unknown) => {
        this.logger.error("Falha ao persistir erro do worker: " + describeError(error), { executionId: event.executionId })
      })
    })
    this.workerLauncher.on("log", (event: { executionId: string; level: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "log", level: event.level as "info" | "warn" | "error", message: event.message })
      this.logger.info("[" + event.level.toUpperCase() + "] " + event.message, { executionId: event.executionId })
    })
    this.workerLauncher.on("progress", (event: { executionId: string; phase: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) {
        worker.executionPhase = event.phase as import("../shared/types/execution.js").ExecutionPhase
        this.publishActivity(worker, { type: "progress", executionPhase: worker.executionPhase, message: event.message })
      }
      this.logger.info("[PROGRESS " + event.phase + "] " + event.message, { executionId: event.executionId })
    })
    this.workerLauncher.on("model_unavailable", (event: { executionId: string; model: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "model_unavailable", level: "warn", model: event.model, message: event.message })
    })
    this.workerLauncher.on("started", (event: { executionId: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "started" })
    })
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.external_id ?? row.id ?? ""),
      chatId: String(row.chat_id ?? ""),
      agentId: String(row.agent_id ?? ""),
      title: String(row.titulo ?? row.title ?? ""),
      description: String(row.descricao ?? row.description ?? ""),
      tipo: isTaskTipo(row.tipo) ? row.tipo : "desenvolvimento",
      repoPath: String(row.repo_path ?? ""),
      buildCommand: String(row.build_command ?? ""), unitTestCommand: String(row.unit_test_command ?? ""),
      unitTestExclude: [], baselineMode: "full",
      status: String(row.status ?? "planned") as Task["status"],
      maxRework: Number(row.max_rework ?? row.default_max_rework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? row.default_hard_timeout_ms ?? getConfigNumber('motor.worker_timeout_ms')),
      dependsOnTaskId: row.depends_on_task_id ? String(row.depends_on_task_id) : undefined,
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    }
  }

  private mapSubtask(row: Record<string, unknown>): SubtaskWithTask {
    return {
      id: Number(row.id),
      seq: Number(row.seq),
      titulo: String(row.titulo ?? ""),
      scope: row.scope ? String(row.scope) : undefined,
      acceptanceCriteria: Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : (typeof row.acceptance_criteria === "string" ? JSON.parse(row.acceptance_criteria) : undefined),
      tarefaId: Number(row.tarefa_id),
      taskExternalId: String(row.task_external_id ?? row.tarefa_id),
      taskTitulo: String(row.task_titulo ?? ""),
      taskDescricao: row.task_descricao ? String(row.task_descricao) : "",
      taskTipo: isTaskTipo(row.task_tipo) ? row.task_tipo : "desenvolvimento",
      repoPath: String(row.repo_path ?? ""),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      branchTrabalho: row.branch_trabalho ? String(row.branch_trabalho) : null,
      agentId: String(row.agent_id ?? ""),
      buildCommand: row.build_command ? String(row.build_command) : null,
      unitTestCommand: row.unit_test_command ? String(row.unit_test_command) : null,
      unitTestExclude: this.parseStringArray(row.unit_test_exclude),
      maxRework: row.task_max_rework === null || row.task_max_rework === undefined ? (row.default_max_rework === null || row.default_max_rework === undefined ? null : Number(row.default_max_rework)) : Number(row.task_max_rework),
      hardTimeoutMs: row.task_hard_timeout_ms === null || row.task_hard_timeout_ms === undefined ? (row.default_hard_timeout_ms === null || row.default_hard_timeout_ms === undefined ? null : Number(row.default_hard_timeout_ms)) : Number(row.task_hard_timeout_ms),
      deliverCount: Number(row.deliver_count ?? 0),
      correctionFingerprint: row.correction_fingerprint ? String(row.correction_fingerprint) : null,
    }
  }

  private assertExecutionConfig(subtask: SubtaskWithTask): asserts subtask is SubtaskWithTask & { buildCommand: string; unitTestCommand: string } {
    const missing = [
      !subtask.repoPath && "repo_path",
      !subtask.branchTrabalho && "branch_trabalho",
      !subtask.buildCommand && "build_command",
      !subtask.unitTestCommand && "unit_test_command",
    ].filter(Boolean)
    if (missing.length > 0) throw new Error("Projeto sem configuração operacional: " + missing.join(", "))
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value !== "string") return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  private async taskHasPersistedPlan(taskId: string): Promise<boolean> {
    const isNumeric = /^\d+$/.test(taskId)
    const { rows } = await this.db.query(
      isNumeric
        ? "SELECT EXISTS(SELECT 1 FROM subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ? OR t.id = ?) AS has_plan"
        : "SELECT EXISTS(SELECT 1 FROM subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ?) AS has_plan",
      isNumeric ? [taskId, taskId] : [taskId],
    )
    return Number(rows[0]?.has_plan ?? 0) === 1
  }

  /**
   * Persiste um bloqueio usando o ID interno de tarefas.
   *
   * O identificador exposto pelo motor é normalmente tarefas.external_id
   * (slug), enquanto bloqueios.tarefa_id é uma FK inteira para tarefas.id.
   * Nunca enviar o slug diretamente para essa coluna: além de falhar em modo
   * strict do MySQL, isso pode transformar o erro original em falha de
   * persistência do bloqueio.
   */
  private async persistTaskBlock(
    taskExternalId: string,
    subtaskId: number | null,
    blockReason: string,
    blockCommand: string,
    blockExcerpt: string,
  ): Promise<void> {
    const subtaskSql = subtaskId === null ? "NULL" : "?"
    const params: unknown[] = subtaskId === null
      ? [blockReason, blockCommand, blockExcerpt, taskExternalId, taskExternalId]
      : [subtaskId, blockReason, blockCommand, blockExcerpt, taskExternalId, taskExternalId]
    await this.db.query(
      "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
      `SELECT t.id, ${subtaskSql}, ?, ?, ?, NOW() FROM tarefas t ` +
      "WHERE t.external_id = ? OR t.id = CAST(? AS UNSIGNED) LIMIT 1",
      params,
    )
  }

  private async saveTaskTransition(
    task: import("../shared/types/infrastructure.js").SaveTaskData,
    transition: TaskTransition,
    patch: Partial<import("../shared/types/infrastructure.js").SaveTaskData> = {},
    options?: { skipBlocker?: boolean },
  ): Promise<void> {
    const previousStatus = task.status as Task["status"]
    switch (transition) {
      case "start_analysis":
        await this.facts.record(task.id, "start_analysis")
        break
      case "analysis_completed":
        await this.facts.record(task.id, "analysis_completed")
        break
      case "execution_completed":
        await this.facts.record(task.id, "integration_confirmed")
        break
      case "cancel":
        await this.facts.record(task.id, "cancelled")
        break
      case "fail": {
        // BUG bloqueio duplicado (2026-09-10): caminhos que já persistem bloqueio
        // detalhado (conflito/erro de promoção) passavam por aqui e geravam uma
        // segunda linha systemic_failure para o mesmo evento. skipBlocker evita a
        // duplicação mantendo o bloqueio detalhado como registro único.
        if (!options?.skipBlocker) {
          const evidence = blockerEvidence("systemic_failure", patch.errorMessage ?? "Falha operacional do Motor")
          await this.persistTaskBlock(task.id, null, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt)
        }
        break
      }
      // start_execution/subtasks_pending/queue/recover descrevem mudanças em
      // subtarefas; clarificação e deploy já possuem fatos próprios.
      default:
        break
    }
    const projectedStatus: Partial<Record<TaskTransition, Task["status"]>> = {
      start_analysis: "analyzing",
      analysis_completed: "ready",
      await_clarification: "awaiting_clarification",
      clarification_answered: "planned",
      start_execution: "running",
      execution_completed: "completed",
      deploy_completed: "deployed",
      subtasks_pending: "ready",
      fail: "blocked",
      cancel: "cancelled",
      recover: "planned",
      queue: "planned",
    }
    const status = projectedStatus[transition] ?? previousStatus
    // O histórico é uma projeção auditável dos fatos; não é usado para tomar
    // decisões nem atualiza tarefas.status.
    await this.db.query(
      "INSERT INTO tarefas_status_historico (tarefa_id, status_anterior, status_novo, origem, motivo) " +
      "SELECT id, ?, ?, ?, ? FROM tarefas WHERE external_id = ? OR id = CAST(? AS UNSIGNED) LIMIT 1",
      [previousStatus, status, `motor-v2:${transition}`, patch.errorMessage?.substring(0, 500) ?? null, task.id, task.id],
    ).catch((error: unknown) => this.logger.warn("Falha ao auditar transição de tarefa: " + describeError(error), { taskId: task.id }))
    // Atualiza o objeto task em memória para manter consistência
    task.status = status as Task["status"]
    if (patch.updatedAt) task.updatedAt = patch.updatedAt
  }

  private publishActivity(worker: ActiveWorker, event: Omit<import("../events/ExecutionEventBus.js").ExecutionActivityEvent, "executionId" | "taskId" | "subtaskId" | "phase" | "timestamp">): void {
    this.eventBus.publish({
      ...event,
      executionId: worker.executionId,
      taskId: worker.taskId,
      subtaskId: worker.subtaskId,
      phase: worker.phase,
      timestamp: new Date(),
    })
  }

  /**
   * P1: conflito no merge subtarefa → branch da tarefa. Decisão Alexandre
   * 2026-09-05: quem resolve é o AGENTE da subtarefa — ela volta a pending e
   * a próxima tentativa deriva do tip da branch da tarefa (que já contém as
   * subtarefas anteriores), permitindo ver e resolver o conflito. O merge é
   * cancelado (nada parcial). Só escala para humano se o conflito se repetir.
   */
  private async handleSubtaskIntegrationConflict(
    worker: ActiveWorker,
    executionId: string,
    conflictFiles: string[],
    reason: string,
  ): Promise<void> {
    const subtaskId = worker.subtaskId!
    const files = conflictFiles.length > 0 ? conflictFiles.join(", ") : "(arquivos não listados)"
    const note = ("Conflito ao integrar na branch da tarefa " + (worker.taskWorkspace?.branch ?? "?") + ": " + files + ". " + reason).substring(0, 500)
    const { rows } = await this.db.query(
      "SELECT COUNT(*) AS total FROM subtarefas_entregas WHERE subtarefa_id = ? AND event_type = 'integration_conflict'",
      [subtaskId],
    )
    const previousConflicts = Number((rows[0] as Record<string, unknown>)?.total ?? 0)
    await this.recordSubtaskDeliveryEvent(subtaskId, "integration_conflict", note)

    if (previousConflicts >= 1) {
      const blockReason = "Conflito de integração repetido na branch da tarefa — intervenção humana necessária. " + note
      this.logger.error(blockReason, { taskId: worker.taskId, subtaskId, executionId })
      try {
        const evidence = blockerEvidence("systemic_failure", blockReason)
        await this.db.query(
          "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
          "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
          [subtaskId, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtaskId],
        )
      } catch (persistError) {
        this.logger.error("Falha ao persistir bloqueio de conflito repetido: " + describeError(persistError), { taskId: worker.taskId, subtaskId })
      }
      await this.db.query(
        "UPDATE subtarefas SET status = 'blocked', workspace_status = 'integration_failed', resultado = ?, updated_at = NOW() WHERE id = ?",
        [blockReason.substring(0, 500), subtaskId],
      )
      const task = await this.repository.getTask(worker.taskId)
      if (task) await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) }, { skipBlocker: true })
      this.publishActivity(worker, { type: "failed", level: "error", message: blockReason })
      await this.finishWorker(executionId, worker)
      return
    }

    await this.db.query(
      "UPDATE subtarefas SET status = 'pending', workspace_status = 'integration_conflict', resultado = ?, finalizada_em = NULL, updated_at = NOW() WHERE id = ?",
      [note, subtaskId],
    )
    this.logger.warn("Conflito na integração com a branch da tarefa; subtarefa re-enfileirada para o agente resolver: " + note, { taskId: worker.taskId, subtaskId, executionId })
    this.publishActivity(worker, {
      type: "progress",
      executionPhase: "publish",
      level: "warn",
      message: "Conflito ao integrar a subtarefa na branch da tarefa (" + files + "). Merge cancelado; a subtarefa volta para o agente resolver na próxima entrega.",
    })
    const task = await this.repository.getTask(worker.taskId)
    if (task) await this.saveTaskTransition(task, "subtasks_pending")
    await this.finishWorker(executionId, worker)
  }

  /**
   * P1: gate de integração (build + testes) na branch da tarefa após cada
   * merge de subtarefa (decisão Alexandre 2026-09-05). Garante que a branch
   * da tarefa só avança verde — a base nunca recebe combinação quebrada de
   * subtarefas. Specs funcionais ficam fora do gate automático (decisão
   * 2026-09-04), igual aos gates de subtarefa.
   */
  private async runTaskIntegrationGate(worker: ActiveWorker): Promise<{ ok: true } | { ok: false; output: string }> {
    const taskWorkspace = worker.taskWorkspace
    if (!taskWorkspace) return { ok: true }
    const buildCommand = worker.buildCommand?.trim()
    const testCommand = worker.testCommand?.trim()
    if (!buildCommand && !testCommand) return { ok: true }

    // Dependências: instala quando ainda não existem no worktree da tarefa ou
    // quando o merge tocou manifesto/lockfile de dependências.
    try {
      const needsInstall = !existsSync(join(taskWorkspace.projectPath, "node_modules")) || this.mergeTouchedDependencyManifests(taskWorkspace.path)
      if (needsInstall) {
        const installer = new DependencyInstaller()
        const outcome = await installer.install({ worktreePath: taskWorkspace.projectPath, timeoutMs: resolveInstallTimeoutMs() })
        if (!outcome.ok) return { ok: false, output: "npm ci falhou no worktree da tarefa: " + (outcome.reason ?? "motivo não informado") }
      }
    } catch (error) {
      return { ok: false, output: "Falha ao preparar dependências no worktree da tarefa: " + describeError(error) }
    }

    const commands = [buildCommand, testCommand ? withBaselineExcludes(testCommand) : undefined].filter((command): command is string => Boolean(command))
    for (const command of commands) {
      this.logger.info("Gate de integração na branch da tarefa: " + command, { taskId: worker.taskId, branch: taskWorkspace.branch })
      try {
        execSync(command, { cwd: taskWorkspace.projectPath, timeout: 900_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      } catch (error) {
        const details = error as { stdout?: string; stderr?: string; message?: string }
        const output = [details.stdout, details.stderr].filter(Boolean).join("\n").slice(-6000) || details.message || "sem saída diagnóstica"
        return { ok: false, output: "Comando falhou na branch da tarefa (" + command + "):\n" + output }
      }
    }
    return { ok: true }
  }

  /** True quando o último commit da branch da tarefa tocou package.json/package-lock.json. */
  private mergeTouchedDependencyManifests(taskWorktreePath: string): boolean {
    try {
      const out = execSync("git diff --name-only HEAD~1 HEAD", { cwd: taskWorktreePath, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] })
      return out.split("\n").some((line) => /(^|\/)package(-lock)?\.json$/.test(line.trim()))
    } catch {
      return true // Na dúvida, reinstala.
    }
  }

  /**
   * P1: gate de integração vermelho → reverte o merge na branch da tarefa e
   * devolve a subtarefa para rework com o diagnóstico (carry-over leva o
   * motivo na próxima entrega). Segunda falha de integração da mesma
   * subtarefa → bloqueio para intervenção humana (anti-loop).
   */
  private async handleTaskIntegrationGateFailure(
    worker: ActiveWorker,
    executionId: string,
    preMergeHead: string,
    output: string,
  ): Promise<void> {
    const subtaskId = worker.subtaskId!
    await this.workspaceManager.revertTaskBranchMerge(worker.taskWorkspace!.path, preMergeHead)
    const digest = digestGateFailure(output, { maxLines: 30, maxChars: 1800 })
    await this.recordSubtaskDeliveryEvent(subtaskId, "integration_gate_failed", digest)
    const { rows } = await this.db.query(
      "SELECT COUNT(*) AS total FROM subtarefas_entregas WHERE subtarefa_id = ? AND event_type = 'integration_gate_failed'",
      [subtaskId],
    )
    const failures = Number((rows[0] as Record<string, unknown>)?.total ?? 0)
    const note = ("Gate de integração vermelho na branch da tarefa; merge revertido. " + digest).substring(0, 500)

    if (failures >= 2) {
      const blockReason = "Gate de integração falhou repetidamente após merge desta subtarefa — intervenção humana necessária. " + note
      this.logger.error(blockReason, { taskId: worker.taskId, subtaskId, executionId })
      try {
        const evidence = blockerEvidence("systemic_failure", blockReason)
        await this.db.query(
          "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
          "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
          [subtaskId, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtaskId],
        )
      } catch (persistError) {
        this.logger.error("Falha ao persistir bloqueio de gate de integração repetido: " + describeError(persistError), { taskId: worker.taskId, subtaskId })
      }
      await this.db.query(
        "UPDATE subtarefas SET status = 'blocked', workspace_status = 'integration_failed', resultado = ?, updated_at = NOW() WHERE id = ?",
        [blockReason.substring(0, 500), subtaskId],
      )
      const task = await this.repository.getTask(worker.taskId)
      if (task) await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) }, { skipBlocker: true })
      this.publishActivity(worker, { type: "failed", level: "error", message: blockReason })
      await this.finishWorker(executionId, worker)
      return
    }

    await this.db.query(
      "UPDATE subtarefas SET status = 'pending', workspace_status = 'integration_reverted', resultado = ?, finalizada_em = NULL, updated_at = NOW() WHERE id = ?",
      [note, subtaskId],
    )
    this.logger.warn("Gate de integração vermelho; merge revertido e subtarefa re-enfileirada: " + note.substring(0, 200), { taskId: worker.taskId, subtaskId, executionId })
    this.publishActivity(worker, {
      type: "progress",
      executionPhase: "publish",
      level: "warn",
      message: "Gate de integração vermelho na branch da tarefa: merge revertido; a subtarefa volta para rework com o diagnóstico.",
    })
    const task = await this.repository.getTask(worker.taskId)
    if (task) await this.saveTaskTransition(task, "subtasks_pending")
    await this.finishWorker(executionId, worker)
  }

  /** Registra evento no histórico de entregas da subtarefa (lado coordenador). */
  private async recordSubtaskDeliveryEvent(subtaskId: number, eventType: string, reason: string | null): Promise<void> {
    try {
      const { rows } = await this.db.query("SELECT deliver_count FROM subtarefas WHERE id = ?", [subtaskId])
      const deliverNumber = Number((rows[0] as Record<string, unknown>)?.deliver_count ?? 0)
      await this.db.query(
        "INSERT INTO subtarefas_entregas (subtarefa_id, deliver_number, model, event_type, reason, created_at) VALUES (?, ?, NULL, ?, ?, NOW())",
        [subtaskId, deliverNumber, eventType, reason ? reason.substring(0, 2000) : null],
      )
    } catch (error) {
      this.logger.warn("Falha ao registrar evento de entrega (coordenador): " + describeError(error), { subtaskId })
    }
  }

  private async promoteOriginalAfterTestOnlyCorrection(subtaskId: number, workspace: { path: string; branch: string; baseCommit: string }, commitSha?: string): Promise<void> {
    if (!commitSha) return
    const { rows } = await this.db.query(
      "SELECT correction_for_subtask_id, correction_fingerprint FROM subtarefas WHERE id = ?",
      [subtaskId],
    )
    const originalId = Number(rows[0]?.correction_for_subtask_id ?? 0)
    if (!originalId) return
    // Correção de baseline (2026-08-31): a original não foi executada — ela
    // volta a pending para rodar depois que a suíte ficar verde. Promovê-la a
    // verified pularia o trabalho real.
    if (isBaselineCorrection(rows[0]?.correction_fingerprint ? String(rows[0].correction_fingerprint) : null)) {
      await this.db.query(
        "UPDATE subtarefas SET status = 'pending', resultado = CONCAT(COALESCE(resultado, ''), '\\nBaseline verde via subtarefa ', ?), updated_at = NOW() WHERE id = ? AND status = 'rejected'",
        [subtaskId, originalId],
      )
      return
    }
    // B8 (2026-08-31): desde o B1 a corretiva herda o escopo COMPLETO da
    // original — verificada a corretiva, o escopo original foi entregue (só
    // testes, ou refeito por inteiro). Deixar a original como rejected para
    // sempre confundia a tela e o histórico (caso tarefa 731, Alexandre).
    let paths: readonly string[] = []
    try {
      paths = await this.workspaceManager.changedPaths(workspace.path, workspace.baseCommit, commitSha)
    } catch (error) {
      this.logger.warn("B8: falha ao comparar diff da corretiva (" + (error instanceof Error ? error.message : String(error)) + "); promovendo original mesmo assim")
    }
    const testOnly = paths.length > 0 && correctionOnlyChangesTests(paths)
    const note = testOnly
      ? "\nGate corrigido pela subtarefa " + subtaskId + " (somente testes alterados); trabalho original mantido."
      : "\nEscopo entregue pela subtarefa corretiva " + subtaskId + " (correção herdou o escopo original)."
    await this.db.query(
      "UPDATE subtarefas SET status = 'verified', resultado = CONCAT(COALESCE(resultado, ''), ?), finalizada_em = NOW(), updated_at = NOW() WHERE id = ? AND status = 'rejected'",
      [note, originalId],
    )
  }

  private async getProjectModelChain(projectSlug: string | null, phase: ModelPhase): Promise<readonly ModelSelection[]> {
    if (!projectSlug) {
      throw new Error(`Configuração de modelos ausente: tarefa sem projeto para a fase ${phase}`)
    }
    const tipo = phase === "analysis" ? "ANALYST" : phase === "development" ? "DEV" : "MONITOR"
    const { rows } = await this.db.query(
      "SELECT provider, model, ordem FROM project_model_selection " +
      "WHERE project_slug = ? AND tipo = ? AND enabled = 1 ORDER BY ordem ASC",
      [projectSlug, tipo],
    )
    if (rows.length === 0) {
      throw new Error(`Configuração de modelos ausente para o projeto ${projectSlug} na fase ${tipo}`)
    }
    return rows.map((row) => ({
      model: `${String(row.provider)}/${String(row.model)}`,
      position: Number(row.ordem) - 1,
      isLocal: String(row.provider).toLowerCase() === "ollama",
    }))
  }

  /**
   * Preflight de manifesto — valida o task-environment.json antes de consumir modelo.
   * Resolve o toplevel git real (pois repo_path pode ser subdiretório de monorepo).
   * Retorna { ok: true } se o manifesto é válido/ausente-sem-obrigatórios;
   * retorna { ok: false, reason } se há bloqueio de ambiente.
   */
  private async runManifestPreflight(
    repoPath: string,
    projectSlug: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Sem projectSlug não há como interpolar o manifesto; pula o preflight
    if (!projectSlug) return { ok: true }
    if (!existsSync(repoPath)) return { ok: true }

    let gitTopLevel: string
    try {
      gitTopLevel = await resolveGitTopLevel(repoPath)
    } catch (error) {
      this.logger.warn("Preflight: falha ao resolver git toplevel (manifesto será ignorado): " + (error instanceof Error ? error.message : String(error)), {
        repoPath,
      })
      return { ok: true }
    }

    const manager = new SecretProfileManager()
    const result = await manager.inspectManifest({
      repoPath: gitTopLevel,
      root: process.env.TASK_SECRETS_ROOT,
      environment: process.env.TASK_ENVIRONMENT ?? "development",
      projectSlug,
    })

    if (result.ok) return { ok: true }
    return { ok: false, reason: result.reason + (result.requiredAction ? " — " + result.requiredAction : "") }
  }

  /**
   * Busca o workspace real do agente no Console.
   * Retorna null se não conseguir buscar ou se o agente não tiver workspace configurado.
   */
  private async getAgentWorkspacePath(agentId: string): Promise<string | null> {
    const baseUrl = process.env.OPENCLAW_CONSOLE_URL
    const token = process.env.OPENCLAW_CONSOLE_TOKEN
    if (!baseUrl || !token) {
      this.logger.warn("OPENCLAW_CONSOLE_URL ou OPENCLAW_CONSOLE_TOKEN não configurados; usando workspace padrão")
      return null
    }
    
    try {
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl, token })
      const workspace = await driver.getAgentWorkspace(agentId)
      if (workspace) {
        this.logger.info(`Workspace do agente ${agentId}: ${workspace}`)
      }
      return workspace
    } catch (error) {
      this.logger.warn(`Falha ao buscar workspace do agente ${agentId}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Verifica se o agente existe no gateway antes de enfileirar a tarefa.
   * Usa o ConsoleAgentRuntimeDriver para consultar a lista de agentes registrados.
   * Retorna o resultado da verificação para o chamador decidir se bloqueia ou não.
   *
   * Se OPENCLAW_CONSOLE_URL/TOKEN não estiverem configurados, a verificação é
   * pulada com aviso (modo desenvolvimento sem Console). Em produção, a ausência
   * dessas variáveis deve ser tratada como erro de configuração.
   */
  private async verifyAgentBeforeEnqueue(
    agentId: string | null | undefined,
  ): Promise<import("../policies/GatewayAgentVerificationPolicy.js").AgentVerificationResult> {
    const baseUrl = process.env.OPENCLAW_CONSOLE_URL
    const token = process.env.OPENCLAW_CONSOLE_TOKEN
    if (!baseUrl || !token) {
      this.logger.warn(
        "OPENCLAW_CONSOLE_URL ou OPENCLAW_CONSOLE_TOKEN não configurados; " +
        "verificação de agente no gateway pulada (modo desenvolvimento)",
      )
      // Sem Console configurado, não podemos verificar — retorna ok=true
      // para não bloquear desenvolvimento local. Em produção, essas vars
      // devem estar configuradas e a verificação é obrigatória.
      return {
        ok: true,
        agentId: agentId ?? '',
        workspace: undefined,
      }
    }

    const driver = new ConsoleAgentRuntimeDriver({ baseUrl, token })
    // Adapter: ConsoleAgentRuntimeDriver.listAgents() -> AgentLookupDriver
    const adapter: import("../policies/GatewayAgentVerificationPolicy.js").AgentLookupDriver = {
      listAgents: () => driver.listAgents(),
    }
    return verifyAgentInGateway(agentId, adapter)
  }
}
