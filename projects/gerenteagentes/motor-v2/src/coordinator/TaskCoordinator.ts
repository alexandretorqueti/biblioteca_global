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
import { GitWorkspaceManager, type TaskPromotionResult } from "../workspaces/GitWorkspaceManager.js"
import { DependencyInstaller, resolveInstallTimeoutMs } from "../workspaces/DependencyInstaller.js"
import { ResourceWaitManager } from "../resources/ResourceWaitManager.js"
import { executionEventBus, type ExecutionEventBus } from "../events/ExecutionEventBus.js"
import { correctionOnlyChangesTests } from "../policies/CorrectionDiffPolicy.js"
import { isBaselineCorrection, withBaselineExcludes } from "../policies/BaselinePolicy.js"
import { digestGateFailure } from "../policies/CarryOverPolicy.js"
import { blockerEvidence } from "../policies/BlockerPolicy.js"
import { transitionTask, type TaskTransition } from "../policies/TaskStateMachine.js"
import { persistTaskClarificationAnswer, fetchPendingTaskClarification, fetchAnsweredTaskClarifications } from "../planning/ClarificationStore.js"
import { createLogger, describeError } from "../shared/logger.js"
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { SecretProfileManager, resolveGitTopLevel } from "../workspaces/SecretProfileManager.js"
import { validateTaskCompletion, formatPromotionValidationReport } from "../policies/PromotionValidationPolicy.js"
import { validateProjectId, formatProjectIdValidationReport } from "../policies/ProjectIdValidationPolicy.js"
import { verifyAgentInGateway, formatAgentVerificationReport, shouldBlockEnqueue } from "../policies/GatewayAgentVerificationPolicy.js"

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
  phase: "analyze" | "execute"
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
  baseBranch?: string
  timeoutHandle?: ReturnType<typeof setTimeout>
  lastHeartbeatAt?: Date
  silenceHandle?: ReturnType<typeof setTimeout>
}

export interface TaskCoordinatorConfig {
  maxWorkers: number
  maxWorkersPerProject: number
  /** Timeout máximo de um worker; quando omitido usa hard_timeout_ms da tarefa. */
  workerTimeoutMs?: number
}

const DEFAULT_CONFIG: TaskCoordinatorConfig = {
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

function isTaskTipo(value: unknown): value is NonNullable<Task["tipo"]> {
  return value === "desenvolvimento" || value === "automacao" || value === "verificacao"
}

function isLightweightTask(tipo: Task["tipo"] | undefined): boolean {
  return tipo === "automacao" || tipo === "verificacao"
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

export class TaskCoordinator {
  private config: TaskCoordinatorConfig
  private activeWorkers = new Map<string, ActiveWorker>()
  private resourceLease: ResourceLeaseService
  private workerLauncher: WorkerLauncher
  private db: Db
  private repository: TaskRepository
  private workspaceManager: GitWorkspaceManager
  private waitManager?: ResourceWaitManager
  private eventBus: ExecutionEventBus
  private finalizingExecutions = new Set<string>()
  private pumping = false
  private logger = createLogger("TaskCoordinator")

  constructor(
    db: Db,
    repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {},
    workerLauncher = new WorkerLauncher(),
    workspaceManager = new GitWorkspaceManager({ root: process.env.MOTOR_WORKSPACE_ROOT ?? "/tmp/motor-v2-workspaces" }),
    waitManager?: ResourceWaitManager,
    eventBus = executionEventBus,
  ) {
    this.db = db
    this.repository = repository
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
      // Com maxWorkers > 1 um único pump precisa preencher todas as vagas;
      // cada iteração inicia no máximo um worker e reconsulta a fila. O laço
      // para quando não há trabalho elegível ou quando o trabalho selecionado
      // não pôde iniciar (recurso em espera, falha de início).
      let guard = 0
      while (this.activeWorkers.size < this.config.maxWorkers && guard <= this.config.maxWorkers) {
        guard += 1

        // 1. Tenta pegar subtarefa pendente (execucao)
        const subtask = await this.selectNextSubtask()
        if (subtask) {
          this.logger.info("Subtarefa selecionada: #" + subtask.seq + " " + subtask.titulo, {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, projectSlug: subtask.projectSlug ?? undefined,
          })
          const started = await this.startSubtaskExecution(subtask)
          if (!started) break
          continue
        }

        // 2. Se nao tem subtarefa, pega tarefa planejada (analise)
        const task = await this.selectNextTask()
        if (task) {
          this.logger.info("Tarefa selecionada para analise: " + task.id + " (" + task.title + ")", {
            taskId: task.id, projectSlug: task.projectSlug ?? undefined,
          })
          const started = await this.startTaskAnalysis(task)
          if (!started) break
          continue
        }
        break
      }
    } finally {
      this.pumping = false
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
      "WHERE t.status = 'planned' AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) ORDER BY t.created_at ASC LIMIT 25"
    )
    return rows.map((row) => this.mapTask(row)).find((task) => this.canStartProject(task.projectSlug)) ?? null
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
      "WHERE s.status = 'pending' AND t.status IN ('ready', 'planned') " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM subtarefas anterior " +
      "WHERE anterior.tarefa_id = s.tarefa_id AND anterior.seq < s.seq AND anterior.status NOT IN ('verified', 'superseded') " +
      "AND anterior.id != COALESCE(s.correction_for_subtask_id, -1)" +
      ") " +
      "ORDER BY s.seq ASC LIMIT 25"
    )
    return rows.map((row) => this.mapSubtask(row)).find((subtask) => this.canStartProject(subtask.projectSlug)) ?? null
  }

  private canStartProject(projectSlug: string | null): boolean {
    if (!projectSlug) return true
    let runningForProject = 0
    for (const worker of this.activeWorkers.values()) {
      if (worker.resourceKey === RESOURCE_KEYS.projectExecution(projectSlug)) runningForProject += 1
    }
    return runningForProject < this.config.maxWorkersPerProject
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startTaskAnalysis(task: Task): Promise<boolean> {
    const executionId = "exec-analyze-" + task.id + "-" + Date.now()
    const resourceKey = task.projectSlug ? RESOURCE_KEYS.projectExecution(task.projectSlug) : null
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
        await this.db.query(
          "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
          "VALUES (?, NULL, ?, ?, ?, NOW())",
          [task.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt],
        )
        await this.repository.saveTask({ ...task, status: "blocked", updatedAt: new Date().toISOString() })
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
    })

    try {
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
      this.activeWorkers.delete(executionId)
      return false
    }
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startSubtaskExecution(subtask: SubtaskWithTask): Promise<boolean> {
    const executionId = "exec-execute-" + subtask.id + "-" + Date.now()
    const resourceKey = subtask.projectSlug ? RESOURCE_KEYS.projectExecution(subtask.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, String(subtask.tarefaId), 120)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(String(subtask.tarefaId), resourceKey, result.waitId, result.position)
        this.logger.info("Subtarefa #" + subtask.seq + " aguardando recurso", {
          taskId: subtask.taskExternalId, subtaskId: subtask.id, projectSlug: subtask.projectSlug ?? undefined,
        })
        return false
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: subtask.taskExternalId, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "execute", subtaskId: subtask.id, taskTipo: subtask.taskTipo,
      repoPath: subtask.repoPath,
      projectSlug: subtask.projectSlug ?? undefined,
    })

    try {
      if (!subtask.agentId) throw new Error("Projeto sem agente configurado")
      if (!isLightweightTask(subtask.taskTipo)) this.assertExecutionConfig(subtask)
      // Marca subtarefa como running
      await this.db.query("UPDATE subtarefas SET status = 'running', iniciada_em = NOW() WHERE id = ?", [subtask.id])
      const parentTask = await this.repository.getTask(subtask.taskExternalId)
      if (parentTask) {
        if (parentTask.status === "planned") {
          await this.repository.saveTask({ ...parentTask, status: "ready", updatedAt: new Date().toISOString() })
          parentTask.status = "ready"
        }
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
        maxRework: subtask.maxRework ?? 3, hardTimeoutMs: subtask.hardTimeoutMs ?? 14_400_000,
        projectSlug: subtask.projectSlug,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: subtask.taskExternalId, projectSlug: subtask.projectSlug,
          phase: "execute", fencingToken, startedAt: new Date(),
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
      this.armWorkerTimeout(executionId, subtask.hardTimeoutMs ?? 14_400_000)

      this.logger.info("Worker de execucao iniciado: subtarefa #" + subtask.seq + " (" + executionId + ")", {
        taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId, phase: "execute",
        projectSlug: subtask.projectSlug ?? undefined,
      })
      return true
    } catch (error) {
      const reason = error instanceof Error ? (error.message || String(error)) : String(error)
      const transientDb = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|PROTOCOL_CONNECTION_LOST|Connection lost/i.test(reason)
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
      const activeWorker = this.activeWorkers.get(executionId)
      if (activeWorker && this.beginFinalization(executionId, activeWorker)) {
        await this.finishWorker(executionId, activeWorker)
      } else if (resourceKey) {
        await this.resourceLease.release(resourceKey, executionId, fencingToken)
      }
      return false
    }
  }

  async onTaskCompleted(executionId: string, result?: ExecutionResult): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return

    try {
    if (worker.phase === "analyze") {
      this.publishActivity(worker, { type: "completed" })
      this.logger.info("Analise completada: " + worker.taskId, { taskId: worker.taskId, executionId, phase: "analyze" })
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        // Uma análise concluída precisa passar por `analyzing`. Se uma
        // persistência concorrente/deploy deixou o registro em `planned`,
        // recupera a etapa intermediária antes de aplicar a transição final;
        // caso contrário, a exceção derruba o processo inteiro do Motor.
        if (task.status === "planned") {
          this.logger.warn("Tarefa ainda planned ao concluir análise; normalizando para analyzing", {
            taskId: worker.taskId, executionId, phase: "analyze",
          })
          await this.repository.saveTask({ ...task, status: "analyzing", updatedAt: new Date().toISOString() })
          task.status = "analyzing"
        }
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
            "SELECT id, seq, workspace_commit_sha, status FROM subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM subtarefas WHERE id = ?) AND status != 'superseded'",
            [worker.subtaskId]
          )
          const promotionValidation = validateTaskCompletion(
            subtasksForValidation.map((st: Record<string, unknown>) => ({
              id: Number(st.id),
              seq: Number(st.seq),
              workspaceCommitSha: st.workspace_commit_sha ? String(st.workspace_commit_sha) : null,
              status: String(st.status),
            }))
          )
          if (!promotionValidation.ok) {
            const promotionReason = promotionValidation.reason ?? "Motivo de bloqueio de promoção não informado"
            this.logger.warn("Validação de promoção bloqueou conclusão da tarefa: " + promotionReason, {
              taskId: worker.taskId, executionId,
            })
            const task = await this.repository.getTask(worker.taskId)
            if (task) {
              // Persiste bloqueio com motivo auditável
              try {
                const evidence = blockerEvidence("blocked_environment", promotionReason)
                await this.db.query(
                  "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
                  "VALUES (?, NULL, ?, ?, ?, NOW())",
                  [task.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt],
                )
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
              let promotion: TaskPromotionResult | null = null
              try {
                promotion = await this.workspaceManager.promoteTaskBranch({
                  repoPath: worker.repoPath,
                  baseBranch: worker.rootBaseBranch,
                  taskBranch: worker.taskWorkspace.branch,
                })
              } catch (promotionError) {
                const reason = promotionError instanceof Error ? promotionError.message : String(promotionError)
                const blockReason = "Falha na promoção da branch da tarefa: " + reason + ". Branch preservada: " + worker.taskWorkspace.branch
                this.logger.error(blockReason, { taskId: worker.taskId, executionId })
                try {
                  const evidence = blockerEvidence("blocked_environment", blockReason)
                  await this.db.query(
                    "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
                    "SELECT tarefa_id, NULL, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
                    [evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, worker.subtaskId],
                  )
                } catch (persistError) {
                  this.logger.error("Falha ao persistir bloqueio de promoção: " + describeError(persistError), { taskId: worker.taskId, executionId })
                }
                await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) })
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
                    [evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, worker.subtaskId],
                  )
                } catch (persistError) {
                  this.logger.error("Falha ao persistir bloqueio de promoção: " + describeError(persistError), { taskId: worker.taskId, executionId })
                }
                await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) })
                this.publishActivity(worker, { type: "failed", level: "error", message: "Conflito no merge da tarefa para a base — resolução humana necessária. Arquivos: " + files })
                // NÃO purga: worktree e branch da tarefa ficam preservados para resolução manual.
                await this.finishWorker(executionId, worker)
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
            
            // Depois tenta deploy
            if (worker.repoPath) {
              const deployResult = this.executeDeployScript(worker.repoPath, worker.taskId)
              if (deployResult.success) {
                this.logger.info("Deploy concluído com sucesso", { taskId: worker.taskId, executionId })
                await this.saveTaskTransition(task, "deploy_completed")
                this.publishActivity(worker, { type: "deployed", level: "info", message: "Deploy realizado com sucesso" })
              } else {
                this.logger.warn("Deploy falhou, mantendo tarefa como completed", { taskId: worker.taskId, executionId, error: deployResult.error })
                await this.db.query(
                  "UPDATE tarefas SET ultima_mensagem_erro = ?, updated_at = NOW() WHERE external_id = ?",
                  ["Deploy falhou: " + (deployResult.error || "erro desconhecido").substring(0, 500), worker.taskId]
                )
                this.publishActivity(worker, { type: "completed", level: "warn", message: "Deploy falhou: " + (deployResult.error || "erro desconhecido") })
              }
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

  async onTaskFailed(executionId: string, error: string, kind = "error"): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    const failure = `[${kind}] ${error}`
    const transient = kind === "timeout" || kind === "lease_lost" || kind === "lease_expired" || kind === "lost"
    this.publishActivity(worker, { type: "failed", level: "error", message: failure })

    this.logger.error("Falha: " + failure, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId, phase: worker.phase })

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
    const task = await this.repository.getTask(worker.taskId)
    if (task) await this.saveTaskTransition(task, "pause")
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
        if (task.status === "planned") {
          await this.repository.saveTask({ ...task, status: "analyzing", updatedAt: new Date().toISOString() })
          task.status = "analyzing"
        }
        if (task.status === "analyzing") {
          await this.saveTaskTransition(task, "await_clarification")
        } else {
          this.logger.warn("Tarefa em status inesperado ao pedir clarificação: " + task.status, { taskId: worker.taskId, executionId })
        }
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
    if (task.status !== "awaiting_clarification") {
      throw new Error("Tarefa " + taskId + " nao esta aguardando esclarecimento (status: " + task.status + ")")
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
      projectSlug: worker.projectSlug ?? null,
      startedAt: worker.startedAt.toISOString(),
      ageMs: Date.now() - worker.startedAt.getTime(),
      lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
    }))
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
      maxWorkersPerProject: this.config.maxWorkersPerProject,
      workers,
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    return this.mapSaveDataToTask(data)
  }

  /**
   * Tarefa completa com subtarefas e motivo de bloqueio na resposta —
   * remove a dependência do fallback direto no banco pela tela de
   * acompanhamento e dá visibilidade ao motivo de bloqueio.
   */
  async getTaskWithSubtasks(taskId: string): Promise<(Task & { subtasks: SubtaskView[]; errorMessage?: string; ultimoBloqueio: UltimoBloqueio | null; clarificacaoPendente: ClarificacaoPendente | null }) | null> {
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

    return { ...task, subtasks, errorMessage: data.errorMessage, ultimoBloqueio, clarificacaoPendente }
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
    // Permite iniciar de draft (recém-criada), planned (pronta para executar)
    // ou paused (retomando). Draft é tratado como planned para o motor.
    if (task.status !== "planned" && task.status !== "paused" && task.status !== "draft") {
      throw new Error("Tarefa " + taskId + " esta em status " + task.status)
    }

    // Validação de projeto_id: tarefas de execução devem referenciar a linha
    // correta de projetos_captados (nunca a da biblioteca, exceto para setup).
    // Regra: projeto_id inválido rejeitado com erro claro na entrada do motor.
    const { rows: taskRows } = await this.db.query(
      "SELECT t.projeto_id, pc.slug as project_slug, pc.agente_id " +
      "FROM tarefas t " +
      "LEFT JOIN projetos_captados pc ON t.projeto_id = pc.id " +
      "WHERE t.external_id = ? LIMIT 1",
      [taskId]
    )
    const taskRow = taskRows[0] as Record<string, unknown> | undefined
    const projetoId = taskRow?.projeto_id == null ? NaN : Number(taskRow.projeto_id)
    const projectSlug = taskRow?.project_slug ? String(taskRow.project_slug) : undefined
    const isSetupTask = taskId.startsWith("setup-")
    const taskType = isSetupTask ? "setup" as const : "execution" as const

    // A ausência da linha também é erro: não deixar o motor prosseguir com
    // joins nulos e só falhar depois como "Unknown agent id".
    const validation = await validateProjectId(
      projetoId,
      { taskType, expectedSlug: task.projectSlug ?? undefined },
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
          await this.db.query(
            "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
            "VALUES (?, NULL, 'agent_not_in_gateway', ?, ?, NOW())",
            [task.id, 'motor-v2:gateway-agent-verification', agentVerification.reason ?? report],
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

    // Se está em draft, transiciona diretamente para planned (atualiza o banco)
    if (task.status === "draft") {
      await this.repository.saveTask({ ...task, status: "planned", updatedAt: new Date().toISOString() })
      task.status = "planned"
    }
    if (task.status !== "planned") {
      await this.saveTaskTransition(task, "queue")
    }
    await this.pump()
    return { executionId: "exec-" + task.id + "-" + Date.now() }
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status !== "running" && task.status !== "analyzing") {
      throw new Error("Tarefa " + taskId + " nao esta em execucao")
    }
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      if (worker.taskId === taskId) {
        await this.workerLauncher.stopWorker(executionId)
        await this.onTaskPaused(executionId, "Pausada via API")
        return
      }
    }
    throw new Error("Worker ativo nao encontrado para tarefa " + taskId)
  }

  async resumeTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status !== "paused") throw new Error("Tarefa " + taskId + " nao esta pausada")
    const hasPlan = await this.taskHasPersistedPlan(taskId)
    await this.saveTaskTransition(task, hasPlan ? "resume" : "resume_without_plan")
    await this.pump()
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("Tarefa " + taskId + " ja esta " + task.status)
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
    void this.workspaceManager.purgeTaskArtifacts({ repoPath, taskId }).then((result) => {
      if (result.worktreesRemoved > 0 || result.branchesRemoved > 0) {
        this.logger.info(`Purga de artefatos: taskId=${taskId}, worktrees=${result.worktreesRemoved}, branches=${result.branchesRemoved}`)
      }
    }).catch((error: unknown) => {
      this.logger.warn("Falha ao purgar artefatos da tarefa " + taskId + ": " + describeError(error))
    })
  }

  /**
   * Executa o script deploy.sh na raiz do repositório do projeto.
   * Retorna sucesso/falha sem bloquear o fluxo principal.
   * Timeout: 15 minutos (900s) conforme especificado no deploy.sh.
   */
  private executeDeployScript(repoPath: string, taskId: string): { success: boolean; error?: string } {
    const deployScript = repoPath + "/deploy.sh"
    
    if (!existsSync(deployScript)) {
      return { success: false, error: "deploy.sh não encontrado em " + repoPath }
    }
    
    this.logger.info("Executando deploy.sh: " + deployScript, { taskId })
    
    try {
      // Timeout: 15 min (900000ms) conforme deploy.sh
      execSync("bash " + deployScript, {
        cwd: repoPath,
        timeout: 900000,
        stdio: "pipe",
        env: { ...process.env }
      })
      return { success: true }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error("Deploy falhou: " + errorMessage, { taskId })
      return { success: false, error: errorMessage.substring(0, 500) }
    }
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
      void this.handleWorkerFailure(
        executionId,
        `Worker excedeu o timeout de ${timeoutMs}ms`,
        "timeout",
      )
    }, timeoutMs)
    this.armSilenceWatchdog(executionId)
  }

  private armSilenceWatchdog(executionId: string): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    const silenceMs = 600_000 // 10 minutos - tempo suficiente para chamadas LLM demoradas
    worker.lastHeartbeatAt = new Date()
    if (worker.silenceHandle) clearTimeout(worker.silenceHandle)
    worker.silenceHandle = setTimeout(() => {
      void this.handleWorkerFailure(executionId, "Worker sem heartbeat por 600000ms", "lost")
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

  private async finishWorker(executionId: string, worker: ActiveWorker, options?: { preserveWorkspace?: boolean }): Promise<void> {
    if (worker.timeoutHandle) {
      clearTimeout(worker.timeoutHandle)
      worker.timeoutHandle = undefined
    }
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
        this.activeWorkers.delete(executionId)
        this.finalizingExecutions.delete(executionId)
        await this.pump()
      }
    }
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on("completed", async (msg: { executionId: string; result: ExecutionResult }) => {
      await this.onTaskCompleted(msg.executionId, msg.result)
    })
    this.workerLauncher.on("failed", async (msg: { executionId: string; error: string }) => {
      await this.onTaskFailed(msg.executionId, msg.error)
    })
    this.workerLauncher.on("clarifying", async (msg: { executionId: string; questionCount: number; summary?: string }) => {
      await this.onTaskClarifying(msg.executionId, msg.questionCount, msg.summary)
    })
    this.workerLauncher.on("heartbeat", (msg: { executionId: string }) => {
      const worker = this.activeWorkers.get(msg.executionId)
      if (!worker) return
      worker.lastHeartbeatAt = new Date()
      this.armSilenceWatchdog(msg.executionId)
      this.publishActivity(worker, { type: "heartbeat" })
      if (!worker.resourceKey) return
      void this.resourceLease.renew(worker.resourceKey, msg.executionId, worker.fencingToken).then((result) => {
        if (result.kind === "lost") {
          this.logger.warn("Lease perdido: " + msg.executionId + " - " + result.reason, { executionId: msg.executionId })
          void this.handleWorkerFailure(msg.executionId, "Lease perdido: " + result.reason, "lease_lost")
        }
      }).catch((error: unknown) => {
        this.logger.error("Falha ao renovar lease: " + msg.executionId + ": " + describeError(error), { executionId: msg.executionId })
      })
    })
    this.workerLauncher.on("worker_exit", (event: { executionId: string; code: number | null }) => {
      if (this.activeWorkers.has(event.executionId)) {
        const reason = event.code === 0
          ? "Worker encerrou sem enviar o evento completed"
          : "Worker encerrado inesperadamente (codigo " + String(event.code) + ")"
        this.logger.error(reason + ": " + event.executionId, { executionId: event.executionId })
        void this.onTaskFailed(event.executionId, reason, "worker_exit").catch((error: unknown) => {
          this.logger.error("Falha ao persistir encerramento do worker: " + describeError(error), { executionId: event.executionId })
        })
      }
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
      if (worker) this.publishActivity(worker, { type: "progress", executionPhase: event.phase as import("../shared/types/execution.js").ExecutionPhase, message: event.message })
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
      hardTimeoutMs: Number(row.hard_timeout_ms ?? row.default_hard_timeout_ms ?? 14_400_000),
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

  private async saveTaskTransition(
    task: import("../shared/types/infrastructure.js").SaveTaskData,
    transition: TaskTransition,
    patch: Partial<import("../shared/types/infrastructure.js").SaveTaskData> = {},
  ): Promise<void> {
    const status = transitionTask(task.status as Task["status"], transition)
    await this.repository.saveTask({ ...task, ...patch, status, updatedAt: new Date().toISOString() })
    // Atualiza o objeto task em memória para manter consistência
    task.status = status
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
      if (task) await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) })
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
      if (task) await this.saveTaskTransition(task, "fail", { errorMessage: blockReason.substring(0, 500) })
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
