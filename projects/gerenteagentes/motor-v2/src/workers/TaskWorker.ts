/**
 * TaskWorker - Pipeline completo com 5 fases
 *
 * Fluxo:
 * 1. ANALYZE: Chama Analista -> cria subtarefas
 * 2. PREPARE: Confere branch base, cria branch de trabalho, checkout
 * 3. EXECUTE: Chama Programador com subtarefa
 * 4. VERIFY: npm run build + npm run test
 * 5. ENTREGA: Registra o commit aprovado; a integração na branch-base é
 *    responsabilidade do TaskCoordinator
 */

import { execFileSync, execSync } from "node:child_process"
import { existsSync } from "node:fs"

import { pathToFileURL } from "node:url"
import { SecretProfileManager, resolveGitTopLevel } from "../workspaces/SecretProfileManager.js"
import { DependencyInstaller, isLockfileOutOfSync, resolveInstallTimeoutMs } from "../workspaces/DependencyInstaller.js"
import { GateFailureClassifier, type GateFailureVerdict } from "../policies/GateFailureClassifier.js"
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import type { WorkerInput, ExecutionContext, ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from "./WorkerProtocol.js"
import { defaultChain, formatSessionKey, isModelUnavailableError, type ModelSelection } from "../policies/ModelTierPolicy.js"
import { isSystemicFailure } from "../policies/SystemFailurePolicy.js"
import { blockerEvidence, type BlockerKind } from "../policies/BlockerPolicy.js"
import { failureFingerprint } from "../policies/SystemFailurePolicy.js"
import { decideGateScope, isTestPath } from "../policies/GateScopePolicy.js"
import {
  isSetupTask,
  isSmokeTestSubtask,
  validateSmokeTestGate,
  generateSmokeTestSubtask,
  planHasSmokeTest,
} from "../policies/SetupSmokeTest.js"
import {
  BASELINE_CORRECTION_CRITERION,
  BASELINE_CORRECTION_TITLE,
  BASELINE_FINGERPRINT_PREFIX,
  baselineCorrectionScope,
  isBaselineCorrection,
  isFunctionalSpec,
  withBaselineExcludes,
} from "../policies/BaselinePolicy.js"
import { hasPersistedPlan, persistPlan } from "../planning/PlanPersistence.js"
import { safeParseAnalystReply, type AnalystReply } from "../planning/AnalystReply.js"
import {
  fetchTaskClarificationHistory,
  formatHistoryForPrompt,
  persistTaskClarification,
} from "../planning/ClarificationStore.js"
import type { Db, QueryResult } from "../shared/types/infrastructure.js"
import { resolveProjectDatabase } from "../database/DrizzleDb.js"
import mysql from "mysql2/promise"
import { getAgentReplyFailureReason } from "../policies/NoReplyFailurePolicy.js"
import { validatePremiseRefutation, type PremiseRefutation } from "../policies/PremiseRefutationPolicy.js"
import { ManagedPromptResolver } from "../prompts/ManagedPromptResolver.js"
import { confirmBaselineIndependentFailure } from "../policies/BaselineConfirmation.js"
import { digestGateFailure, formatCarryOver, type CarryOverEvent } from "../policies/CarryOverPolicy.js"

const COMMAND_FAILURE_LIMIT = 12_000
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/**
 * Limite da descrição enviada AO ANALISTA. Ele só precisa de contexto
 * suficiente para quebrar a tarefa; a descrição integral continua chegando
 * ao programador na fase EXECUTE (buildProgrammerPrompt injeta até 12KB).
 * Descrições gigantes (ex.: 7KB+) faziam o analista refletir a especificação
 * nos scopes e estourar o teto de saída do modelo no meio do JSON (2026-09-01).
 */
const ANALYST_DESCRIPTION_LIMIT = 4000

export function truncateDescriptionForAnalyst(description?: string): string {
  const full = (description || "N/A").trim() || "N/A"
  if (full.length <= ANALYST_DESCRIPTION_LIMIT) return full
  return (
    full.substring(0, ANALYST_DESCRIPTION_LIMIT) +
    "\n[descricao truncada para a analise; o programador recebe a descricao completa na execucao]"
  )
}

/**
 * Feedback corretivo enviado ao analista quando a resposta veio truncada ou
 * inválida: uma única nova chance no mesmo modelo antes de escalar a escada.
 */
export function analystCorrectiveFeedback(kind: "truncated" | "invalid"): string {
  if (kind === "truncated") {
    return [
      "Sua resposta anterior foi cortada no meio do JSON (provavelmente atingiu o limite de saida do modelo).",
      "Responda de novo com o MESMO formato JSON, porem mais curto: menos subtarefas, scopes de ate 500 caracteres, criterios de aceite curtos.",
      "Nao repita a descricao da tarefa. Responda APENAS com o JSON.",
    ].join(" ")
  }
  return [
    "Sua resposta anterior nao continha JSON valido no formato esperado.",
    "Responda APENAS com o JSON esperado (plano com subtarefas ou perguntas), sem texto ao redor.",
  ].join(" ")
}

type CommandFailure = {
  stdout?: string | Buffer
  stderr?: string | Buffer
  message?: string
  status?: number | null
  signal?: NodeJS.Signals | null
}

function cleanCommandOutput(value: string | Buffer | undefined): string {
  return (typeof value === "string" ? value : value?.toString() ?? "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r/g, "")
    .trim()
}

/**
 * Mantém stdout e stderr: Vitest escreve avisos React em stderr, mas a
 * asserção e o resumo da falha em stdout. O final é mais relevante que o
 * início porque os runners imprimem o resumo depois da execução da suíte.
 */
export function formatCommandFailure(error: CommandFailure, limit = COMMAND_FAILURE_LIMIT): string {
  const stdout = cleanCommandOutput(error.stdout)
  const stderr = cleanCommandOutput(error.stderr)
  const metadata = [
    error.status != null ? `exit=${error.status}` : "",
    error.signal ? `signal=${error.signal}` : "",
  ].filter(Boolean).join(" ")
  const sections = [
    metadata,
    stdout ? `[stdout]\n${stdout}` : "",
    stderr ? `[stderr]\n${stderr}` : "",
    !stdout && !stderr ? cleanCommandOutput(error.message) : "",
  ].filter(Boolean)
  const combined = sections.join("\n\n") || "Comando encerrou sem saída diagnóstica"
  return combined.length <= limit ? combined : "[saída truncada; exibindo o final]\n" + combined.slice(-limit)
}

export function confirmationTestCommand(originalCommand: string, failure: string): string {
  if (!originalCommand.trim().startsWith("npm run test")) return originalCommand
  const files = [...failure.matchAll(/(?:^|\s)((?:[\w@.-]+\/)*[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?)/gm)]
    .map((match) => match[1])
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 10)
  if (files.length === 0) return originalCommand
  return "npm run test -- " + files.map((file) => `\"${file}\"`).join(" ")
}

function isSafeBranchName(branch: string): boolean {
  return Boolean(
    branch &&
      branch.length <= 240 &&
      /^[a-zA-Z0-9._/-]+$/.test(branch) &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !branch.startsWith("/") &&
      !branch.endsWith("/") &&
      !branch.endsWith(".") &&
      !branch.endsWith(".lock"),
  )
}

class TaskWorker {
  private executionId: string
  private cancelled = false
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private db: mysql.Connection | null = null

  constructor() {
    this.executionId = process.env.EXECUTION_ID ?? "unknown"
  }

  async start(): Promise<void> {
    this.send({ type: "ready", workerId: this.executionId })

    this.db = await mysql.createConnection({
      host: process.env.MYSQL_HOST ?? "mysql",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASSWORD ?? "",
      database: resolveProjectDatabase(),
    })

    process.on("message", async (msg: unknown) => {
      try {
        await this.handleMessage(msg as CoordinatorToWorkerMessage)
      } catch (error) {
        this.log("error", "Erro no handler de mensagem: " + (error instanceof Error ? error.message : String(error)))
        // Envia failed para o coordenador saber que o worker travou
        this.send({ type: "failed", executionId: this.executionId, error: error instanceof Error ? error.message : String(error) })
        this.cleanup()
        setTimeout(() => process.exit(1), 1000)
      }
    })

    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 10000)
    process.on("SIGTERM", () => this.shutdown())
    process.on("SIGINT", () => this.shutdown())
  }

  private async handleMessage(msg: CoordinatorToWorkerMessage): Promise<void> {
    switch (msg.type) {
      case "start":
        await this.execute(msg.input)
        break
      case "cancel":
        this.cancelled = true
        this.log("warn", "Cancelamento: " + msg.reason)
        break
      case "shutdown":
        this.shutdown()
        break
    }
  }

  private async execute(input: WorkerInput): Promise<void> {
    const ctx = input.context
    try {
      this.send({ type: "started", executionId: ctx.executionId })
      let gitCommitSha: string | undefined

      if (ctx.phase === "analyze") {
        const outcome = await this.phaseAnalyze(input)
        if (outcome.kind === "clarifying") {
          this.sendClarifying(ctx, outcome)
          return
        }
      } else if (ctx.phase === "execute") {
        if (this.isDevelopmentTask(input)) await this.phasePrepare(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        gitCommitSha = await this.phaseExecute(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        if (gitCommitSha && this.isDevelopmentTask(input)) await this.phasePublish(input, gitCommitSha)
      }

      this.sendCompleted(ctx, { ok: true, gitCommitSha })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log("error", "Erro: " + reason)
      this.sendFailed(ctx, reason)
    } finally {
      if (this.db) await this.db.end().catch(() => {})
    }
  }

  /**
   * FASE 1: ANALYZE - Chama o Analista para criar subtarefas (ou perguntar)
   */
  private async phaseAnalyze(input: WorkerInput): Promise<{ kind: "done" } | { kind: "clarifying"; questionCount: number; summary?: string }> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "analyze", message: "Iniciando analise" })
    this.log("info", "Fase ANALYZE: " + input.task.title)

    const planningDb = this.planningDb()
    if (await hasPersistedPlan(planningDb, input.task.id)) {
      this.log("info", "Plano persistido encontrado; análise não será repetida")
      return { kind: "done" }
    }

    // Rodada de retomada após resposta de clarificação: reinjeta o histórico
    // (perguntas + respostas) no prompt, pois cada análise roda em sessão nova.
    let clarificationHistory = ""
    try {
      const history = await fetchTaskClarificationHistory(planningDb, input.task.id)
      clarificationHistory = formatHistoryForPrompt(history)
      if (clarificationHistory) this.log("info", "Retomando análise com histórico de clarificação (" + history.length + " mensagens)")
    } catch (error) {
      this.log("warn", "Falha ao carregar histórico de clarificação: " + (error instanceof Error ? error.message : String(error)))
    }

    const driver = this.createDriver()
    const chain = this.chainFor(input, "analysis")
    const embeddedPrompt = this.buildAnalystPrompt(input.task, clarificationHistory)
    const promptKey = clarificationHistory ? "analista.retomada_apos_clarificacao" : "analista.primeira_rodada_tarefa"
    const prompt = await this.resolveManagedPrompt(promptKey, {
      "**TITULOTAREFA**": input.task.title,
      "**DESCRICAOTAREFA**": truncateDescriptionForAnalyst(input.task.description),
      "**TIPOTAREFA**": input.task.tipo ?? "desenvolvimento",
      "**HISTORICOCLARIFICACAO**": clarificationHistory ?? "",
    }, embeddedPrompt, input.task.id)

    let lastFailure: string | undefined
    for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
      const model = chain[modelIndex]!
      const sessionKey = formatSessionKey({ agentId: input.task.agentId, taskId: input.task.id, phase: "analysis", model: model.model, modelIndex, generation: 0 })
      let session

      try {
        session = await driver.createSession({
          agentId: input.task.agentId,
          key: sessionKey,
          label: sessionKey,
          model: model.model,
        })

        this.log("info", "Enviando prompt para analista (modelo " + model.model + ")...")
        const { runId } = await driver.sendMessage({ session, message: prompt })
        this.log("info", "Analista respondendo... runId=" + runId)

        const result = await driver.waitForRunCompletion(session, runId, {
          onActivity: () => this.sendHeartbeat(),
        })
        const stopInfo = result.stopReason && result.stopReason !== "done" ? `, stopReason=${result.stopReason}` : ""
        this.log("info", "Resultado do analista: state=" + result.state + ", contentLength=" + (result.content?.length || 0) + stopInfo)

        if (result.state !== "final" || !result.content) {
          lastFailure = "Analista falhou: " + (result.errorMessage || result.state)
          this.log("warn", lastFailure)
          continue
        }

        let parsed = safeParseAnalystReply(result.content)

        if (!parsed.ok) {
          // Resposta truncada (teto de saida do modelo) ou invalida: falha
          // retryavel, nao terminal. Da UMA chance extra ao mesmo modelo com
          // feedback corretivo; se persistir, escala para o proximo modelo da
          // escada (antes qualquer erro de parse bloqueava a tarefa).
          this.log("warn", `Resposta do analista invalida (${parsed.failure.kind}${stopInfo}): ${parsed.failure.message}`)
          try {
            const { runId: retryRunId } = await driver.sendMessage({
              session,
              message: analystCorrectiveFeedback(parsed.failure.kind),
            })
            this.log("info", "Retry corretivo enviado ao analista (" + model.model + ")... runId=" + retryRunId)
            const retryResult = await driver.waitForRunCompletion(session, retryRunId, {
              onActivity: () => this.sendHeartbeat(),
            })
            if (retryResult.state === "final" && retryResult.content) {
              parsed = safeParseAnalystReply(retryResult.content)
              if (!parsed.ok) {
                this.log("warn", "Retry corretivo tambem retornou resposta invalida (" + parsed.failure.kind + "): " + parsed.failure.message)
              }
            } else {
              this.log("warn", "Retry corretivo nao retornou resultado final: " + (retryResult.errorMessage || retryResult.state))
            }
          } catch (retryError) {
            this.log("warn", "Retry corretivo falhou: " + (retryError instanceof Error ? retryError.message : String(retryError)))
          }
        }

        if (!parsed.ok) {
          lastFailure = `Analista retornou resposta invalida (${parsed.failure.kind}): ${parsed.failure.message}`
          this.log("warn", lastFailure + "; escalando para o proximo modelo da escada")
          continue
        }

        const reply: AnalystReply = parsed.reply

        if (reply.kind === "perguntas") {
          // Ambiguidade: persiste as perguntas no chat da tarefa e para.
          // A tarefa fica aguardando a resposta do dono/agente do projeto;
          // quando ela chegar, o motor reexecuta a análise com o histórico.
          await persistTaskClarification(planningDb, input.task.id, {
            summary: reply.resumo,
            questions: reply.perguntas,
          })
          this.log("info", "Analista pediu esclarecimentos (" + reply.perguntas.length + " perguntas); tarefa aguardando resposta")
          return { kind: "clarifying", questionCount: reply.perguntas.length, summary: reply.resumo || undefined }
        }

        const subtarefas = reply.subtarefas
        this.log("info", "Analista criou " + subtarefas.length + " subtarefas")

        // Smoke test obrigatório em setup de projeto novo (controle de código).
        // Se a tarefa é de setup e o analista não incluiu a subtarefa de smoke
        // test, o motor injeta automaticamente como última subtarefa do plano.
        if (isSetupTask(input.task.title, input.task.description) && !planHasSmokeTest(subtarefas)) {
          const smokeTestSeq = subtarefas.length + 1
          subtarefas.push(generateSmokeTestSubtask(smokeTestSeq))
          this.log("info", "Setup detectado: subtarefa de smoke test injetada (seq=" + smokeTestSeq + ")")
        }

        const persisted = await persistPlan(planningDb, input.task.id, subtarefas)
        if (persisted === "already_persisted") {
          this.log("info", "Plano foi persistido por outra execução; preservando-o")
        }
        this.log("info", "Fase ANALYZE concluida: " + subtarefas.length + " subtarefas criadas")
        return { kind: "done" }
      } catch (error) {
        if (isModelUnavailableError(error)) {
          lastFailure = `Modelo indisponível: ${model.model}`
          this.send({ type: "model_unavailable", executionId: input.context.executionId, model: model.model, message: lastFailure })
          this.log("warn", lastFailure)
          continue
        }
        throw error
      } finally {
        if (session) await driver.closeSession(session).catch(() => {})
      }
    }

    const reason = "Escada de modelos esgotada na análise: " + (lastFailure || "nenhum modelo disponível")
    throw new Error(reason)
  }

  /**
   * FASE 2: PREPARE - Valida o worktree exclusivo, materializa segredos e instala dependências
   */
  private async phasePrepare(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "prepare", message: "Preparando workspace" })
    this.log("info", "Fase PREPARE: " + input.repoPath)

    const repoPath = input.repoPath
    if (!existsSync(repoPath)) {
      throw new Error("Repositorio nao encontrado: " + repoPath)
    }

    const workBranch = input.workBranch
    if (!workBranch) throw new Error("Worktree isolado não fornecido")
    const currentBranch = this.exec("git branch --show-current", repoPath).trim()
    if (currentBranch !== workBranch) throw new Error("Worktree não está na branch exclusiva esperada")

    this.log("info", "Workspace isolado validado: branch " + workBranch)

    // Materializa segredos do manifesto (task-environment.json)
    await this.materializeSecrets(input)

    // Instala dependências (npm ci) se houver package-lock.json
    await this.installDependencies(repoPath)
  }

  /**
   * Materializa arquivos .env no worktree a partir do manifesto task-environment.json.
   * Resolve o toplevel git real (monorepo) para ler o manifesto.
   * Segurança git (check-ignore + ls-files) é verificada pelo SecretProfileManager.
   */
  private async materializeSecrets(input: WorkerInput): Promise<void> {
    const projectSlug = input.context.projectSlug
    if (!projectSlug) {
      this.log("info", "Materialização de segredos pulada: tarefa sem projectSlug")
      return
    }

    const secretsRoot = process.env.TASK_SECRETS_ROOT
    const environment = process.env.TASK_ENVIRONMENT ?? "development"

    let gitTopLevel: string
    try {
      gitTopLevel = await resolveGitTopLevel(input.repoPath)
    } catch (error) {
      this.log("warn", "Falha ao resolver git toplevel para materialização de segredos: " + (error instanceof Error ? error.message : String(error)))
      return
    }

    const manager = new SecretProfileManager()
    const result = await manager.materializeManifest({
      repoPath: input.repoPath,
      manifestRepoPath: gitTopLevel,
      root: secretsRoot,
      environment,
      projectSlug,
    })

    if (!result.ok) {
      throw new Error("Ambiente bloqueado: falha ao materializar segredos — " + result.reason)
    }

    if (result.ok && result.keys.length > 0) {
      this.log("info", "Segredos materializados: " + result.keys.length + " chaves (alvos: .env)")
    } else {
      this.log("info", "Materialização de segredos: nenhum arquivo materializado (manifesto opcional ou root ausente)")
    }
  }

  /**
   * Instala dependências via npm ci se houver package-lock.json na raiz do worktree.
   * Delega ao DependencyInstaller (módulo testável com runner injetável).
   * Salvaguarda: captura git status antes/depois; se npm ci alterar arquivo rastreado, falha.
   * Timeout configurável via TASK_DEPENDENCY_INSTALL_TIMEOUT_MS (default 15min).
   */
  private async installDependencies(worktreePath: string): Promise<void> {
    this.send({ type: "progress", executionId: this.executionId, phase: "prepare", message: "Instalando dependencias (npm ci)" })

    const installer = new DependencyInstaller()
    const result = await installer.install({
      worktreePath,
      timeoutMs: resolveInstallTimeoutMs(),
    })

    if (!result.ok) {
      throw new Error("Ambiente bloqueado: " + result.reason)
    }

    if (result.skipped) {
      this.log("info", "npm ci pulado: " + (result.reason ?? "package-lock.json ausente"))
    } else if (result.lockfileRegenerated) {
      this.log("warn", "Lockfile regenerado automaticamente (npm install fallback) — o agente criou pacote workspace sem sincronizar package-lock.json")
    }
  }

  /**
   * FASE 3: EXECUTE - Chama o Programador com a subtarefa
   */
  private async phaseExecute(input: WorkerInput): Promise<string | undefined> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "execute", message: "Executando subtarefa" })

    const subtask = input.subtask
    if (!subtask) {
      throw new Error("Subtarefa nao fornecida na fase execute")
    }

    this.log("info", "Fase EXECUTE: " + subtask.titulo)

    if (this.isDevelopmentTask(input)) {
      const baselineOutcome = await this.runBaselineCheck(input, subtask)
      if (baselineOutcome === "correction_created") {
        this.log("warn", "Baseline vermelho: subtarefa de correção criada; execução da subtarefa adiada")
        return undefined
      }
    }

    const chain = this.chainFor(input, "development")
    // Uma retomada não pode apagar as entregas já registradas no banco.
    let deliverCount = subtask.deliverCount
    let lastFailure = ""
    const modelFailures: string[] = []

    // P1 (Alexandre 2026-09-05): carry-over de aprendizado entre execuções.
    // Se a subtarefa já teve entregas persistidas (rework pós-rejeição,
    // retomada), o histórico estruturado vai no prompt do programador para
    // que ele não repita abordagens que já falharam.
    const carryOver = await this.buildCarryOver(subtask)

    modelLoop: for (let modelIndex = 0; modelIndex < chain.length; modelIndex += 1) {
      const model = chain[modelIndex]!
      for (let attempt = 1; attempt <= input.task.maxRework; attempt += 1) {
        deliverCount += 1
        await this.db!.query(
          "UPDATE subtarefas SET status = 'running', deliver_count = ?, resultado = NULL, updated_at = NOW() WHERE id = ?",
          [deliverCount, subtask.id],
        )
        // Registra início da entrega no histórico
        await this.recordDeliveryEvent(subtask.id, deliverCount, model.model, "delivery_started", null)
        this.send({ type: "progress", executionId: input.context.executionId, phase: "execute", message: `Entrega ${deliverCount}, modelo ${model.model}` })

        const driver = this.createDriver()
        const sessionKey = formatSessionKey({ agentId: input.task.agentId, taskId: input.task.id, phase: "development", model: model.model, modelIndex, generation: attempt - 1 })
        let session
        let agentSummary: string | null = null
        try {
          session = await driver.createSession({
            agentId: input.task.agentId,
            key: sessionKey,
            label: sessionKey,
            model: model.model,
            // workspacePath não é suportado para sessões normais do Console
            // (apenas subagent:* ou acp:*). O caminho vai no prompt.
          })
          const { header: embeddedHeader, context } = this.buildProgrammerPrompt(
            input.task,
            subtask,
            input.repoPath,
            lastFailure || undefined,
            [carryOver, agentSummary && "Relato do agente na entrega anterior: " + agentSummary].filter(Boolean).join("\n\n") || undefined,
          )
          const promptKey = lastFailure ? "dev.retorno_por_falha_de_gate" : "dev.primeira_rodada_tarefa"
          const header = await this.resolveManagedPrompt(promptKey, {
            "**TITULOTAREFA**": input.task.title,
            "**DESCRICAOTAREFA**": input.task.description ?? "",
            "**TIPOTAREFA**": input.task.tipo ?? "desenvolvimento",
            "**NUMSUBTAREFA**": subtask.seq,
            "**TITULOSUBTAREFA**": subtask.titulo,
            "**ESCOPO**": subtask.scope ?? subtask.titulo,
            "**CRITERIOSACEITE**": subtask.acceptanceCriteria ?? [],
            "**WORKSPACE**": input.repoPath,
            "**ERROGATEANTERIOR**": lastFailure,
          }, embeddedHeader, input.task.id, subtask.id)
          // Envia contexto separado se a missao for longa (evita truncamento no viewer)
          if (context) {
            await driver.sendMessage({ session, message: context })
          }
          const { runId } = await driver.sendMessage({ session, message: header })
          const result = await driver.waitForRunCompletion(session, runId, {
            onActivity: () => this.sendHeartbeat(),
          })
          if (result.state !== "final") {
            lastFailure = "Programador falhou: " + (result.errorMessage || result.state)
            break
          }
          agentSummary = this.extractAgentSummary(result.content)

          // O gateway pode usar state=final mesmo sem produzir uma resposta.
          // Essa mensagem nunca pode atravessar o gate como entrega válida.
          const replyFailureReason = getAgentReplyFailureReason(result.content)
          if (replyFailureReason) {
            await this.db!.query(
              "UPDATE subtarefas SET status = 'pending', resultado = ?, finalizada_em = NULL, updated_at = NOW() WHERE id = ?",
              [replyFailureReason, subtask.id],
            )
            this.log("warn", "Agente não produziu resposta verificável; subtarefa reenfileirada: " + subtask.id)
            return undefined
          }

          // Tarefas operacionais não têm artefato de código como entrega. A
          // resposta do agente é a própria evidência e deve ser registrada no
          // chat assim que o run termina, antes de interpretar o status dela.
          // Isso também preserva respostas de `need_help` e
          // `blocked_environment`, que não chegam ao bloco de sucesso abaixo.
          if (!this.isDevelopmentTask(input)) {
            await this.persistLightweightDelivery(input, result.content || "")
          }

          const outcome = this.classifyAgentOutcome(result.content)
          if (outcome.kind === "blocked_environment") {
            const reason = "Ambiente bloqueado: " + outcome.reason
            await this.recordBlocker(subtask, "blocked_environment", reason, model.model)
            throw new Error(reason)
          }
          if (outcome.kind === "need_help") {
            lastFailure = outcome.reason
            break
          }
          if (outcome.kind === "premise_incorrect") {
            const validation = validatePremiseRefutation(outcome.payload, input.repoPath)
            if (!validation.ok) {
              lastFailure = `Refutação inválida: ${validation.reason}. Continue a execução ou apresente evidências verificáveis.`
              continue
            }
            const revised = await this.rebriefRefutedSubtask(input, subtask, validation.refutation)
            await this.replaceRefutedSubtask(subtask, validation.refutation, validation.fingerprint, model.model, revised)
            return undefined
          }

          let gitCommitSha: string | undefined
          try {
            if (this.isDevelopmentTask(input)) {
              await this.db!.query(
                "UPDATE subtarefas SET status = 'verifying', updated_at = NOW() WHERE id = ?",
                [subtask.id],
              )
              const verification = await this.phaseVerify(input)
              if (verification.kind === "baseline_correction_created") {
                // Falha independente das alterações confirmada via stash: a
                // subtarefa original foi rejeitada e uma correção de baseline
                // foi criada na posição dela. Adia a execução (o pump pega a
                // correção); não conta como falha do agente.
                this.log("warn", "Baseline vermelho confirmado via stash: correção criada; subtarefa original adiada")
                return undefined
              }
              gitCommitSha = await this.phaseCommit(input)
            } else {
              // Automação/verificação é uma entrega operacional: a resposta já
              // foi gravada no chat acima. Não há workspace nem gates de código.
            }
          } catch (error) {
            lastFailure = error instanceof Error ? error.message : String(error)
            await this.db!.query(
              "UPDATE subtarefas SET status = 'rejected', resultado = ?, updated_at = NOW() WHERE id = ?",
              [lastFailure.substring(0, 500), subtask.id],
            )
            // Registra rejeição do gate no histórico — em formato digest para o
            // carry-over das próximas entregas não receber ruído (HTML de
            // componente, stack de biblioteca) no lugar da asserção real.
            const gateDigest = digestGateFailure(lastFailure, { maxLines: 30, maxChars: 1800 })
            await this.recordDeliveryEvent(subtask.id, deliverCount, model.model, "gate_rejected", gateDigest)
            this.log("warn", `Gate vermelho (${model.model}, tentativa ${attempt}): ${lastFailure}`)
            
            // MONITORAMENTO MOTOR: classificar causa raiz antes de decidir fluxo
            const verdict = await this.classifyGateFailure(input, subtask, model.model, modelIndex, lastFailure)
            if (verdict) {
              this.log("info", `Veredito do monitor: ${verdict.verdict} — ${verdict.analysis.substring(0, 200)}`)
              
              // Decidir fluxo baseado no veredito
              if (verdict.verdict === "motor_issue") {
                // Problema no motor: bloquear tarefa para intervenção
                const blockReason = `motor_issue: ${verdict.analysis}${verdict.solution ? ` — Solução proposta: ${verdict.solution}` : ""}`
                await this.recordBlocker(subtask, "systemic_failure", blockReason, model.model)
                throw new Error(blockReason)
              }
              
              if (verdict.verdict === "test_files_issue") {
                // Problema nos testes: criar subtarefa de correção de testes
                this.log("warn", `Problema em arquivos de teste detectado pelo monitor: ${verdict.analysis.substring(0, 200)}`)
                // Continua para createCorrectionOnRepeatedGateFailure que criará subtarefa de correção
              }
              
              // agent_can_solve e code_files_issue: fluxo normal (rework/escala)
            }
            
            if (await this.createCorrectionOnRepeatedGateFailure(input, subtask, model.model, lastFailure)) return undefined
            continue
          }

          // Smoke test: se a subtarefa é de smoke test, validar evidência
          // funcional antes de marcar como verified. Controle de código —
          // sem evidência de chamada HTTP bem-sucedida, o gate reprova.
          if (isSmokeTestSubtask(subtask.titulo)) {
            const smokeValidation = validateSmokeTestGate(
              subtask.titulo,
              result.content,
              input.context.projectSlug,
            )
            if (!smokeValidation.ok) {
              const reason = "Smoke test sem evidência funcional: " + smokeValidation.reason
              this.log("warn", reason)
              await this.db!.query(
                "UPDATE subtarefas SET status = 'rejected', resultado = ?, updated_at = NOW() WHERE id = ?",
                [reason.substring(0, 500), subtask.id],
              )
              lastFailure = reason
              if (await this.createCorrectionOnRepeatedGateFailure(input, subtask, model.model, lastFailure)) return undefined
              continue
            }
            this.log("info", "Smoke test validado: " + smokeValidation.evidence.url + " (status " + smokeValidation.evidence.status + ")")
          }

          if (this.isDevelopmentTask(input)) {
            await this.db!.query(
              "UPDATE subtarefas SET status = 'verified', deliver_count = ?, resultado = ?, finalizada_em = NOW(), updated_at = NOW() WHERE id = ?",
              [deliverCount, result.content?.substring(0, 500) || "OK", subtask.id],
            )
          } else {
            // O chat é a entrega das tarefas operacionais; não duplique a
            // resposta em um campo estruturado de resultado.
            await this.db!.query(
              "UPDATE subtarefas SET status = 'verified', deliver_count = ?, resultado = NULL, finalizada_em = NOW(), updated_at = NOW() WHERE id = ?",
              [deliverCount, subtask.id],
            )
          }
          // Registra conclusão bem-sucedida no histórico
          await this.recordDeliveryEvent(subtask.id, deliverCount, model.model, "completed", null)
          this.log("info", "Subtarefa verificada: " + subtask.titulo)
          return gitCommitSha
        } catch (error) {
          if (isModelUnavailableError(error)) {
            lastFailure = `Modelo indisponível: ${model.model}`
            this.send({ type: "model_unavailable", executionId: input.context.executionId, model: model.model, message: lastFailure })
            this.log("warn", lastFailure)
            continue modelLoop
          }
          throw error
        } finally {
          if (session) await driver.closeSession(session).catch(() => {})
        }
      }
      modelFailures.push(lastFailure || `Modelo ${model.model} não entregou resultado verificável`)
      this.log("warn", `Escalando modelo após falha: ${model.model}`)
    }
    // Uma falha idêntica em dois modelos não encerra a escada: ainda pode
    // haver um terceiro (ou mais) modelo capaz de concluir a subtarefa.
    // Só classifica como sistêmica depois que todos os modelos foram tentados.
    if (isSystemicFailure(modelFailures)) {
      const reason = "Falha sistêmica repetida entre modelos: " + lastFailure
      await this.recordBlocker(subtask, "systemic_failure", reason)
      throw new Error(reason)
    }
    const reason = "Escada de modelos esgotada: " + (lastFailure || "subtarefa não aprovada")
    await this.recordBlocker(subtask, "model_chain_exhausted", reason)
    throw new Error(reason)
  }

  private isDevelopmentTask(input: WorkerInput): boolean {
    return (input.task.tipo ?? "desenvolvimento") === "desenvolvimento"
  }

  /** Registra a resposta operacional no chat da tarefa para automações e verificações. */
  private async persistLightweightDelivery(input: WorkerInput, content: string): Promise<void> {
    if (!this.db) throw new Error("DB não conectado para registrar entrega")
    const text = content.trim() || "Agente finalizou sem mensagem de resposta."
    await this.db.query(
      "INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) " +
      "SELECT id, 'assistant', ?, NOW() FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1",
      [text.substring(0, 30_000), input.task.id, input.task.id],
    )
  }

  /**
   * FASE 4: VERIFY - build + gate de testes.
   *
   * Gate escopado por subtarefa (2026-08-31): a suíte completa do monorepo
   * só roda quando a alteração toca configuração transversal ou quando a
   * subtarefa é uma correção de baseline; caso contrário rodam apenas os
   * testes afetados pelos caminhos alterados (ou nenhum, se não houver teste
   * afetado). Isso evita que testes flaky/alheios reprovem entregas simples.
   */
  private async phaseVerify(input: WorkerInput): Promise<{ kind: "verified" } | { kind: "baseline_correction_created" }> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "verify", message: "Verificando build e teste" })
    this.log("info", "Fase VERIFY: build + test")

    this.log("info", "Executando: " + input.buildCommand)
    try {
      this.exec(input.buildCommand, input.repoPath, 300_000)
      this.log("info", "Build OK")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Auto-recovery: se o build falhou por lockfile desatualizado (agente
      // alterou package.json sem rodar npm install), tenta npm install e
      // roda o build novamente. Isso evita consumir tentativa do agente por
      // problema de infraestrutura.
      if (isLockfileOutOfSync(msg)) {
        this.log("warn", "Build falhou com lockfile desatualizado; tentando npm install + rebuild...")
        try {
          this.exec("npm install", input.repoPath, 300_000)
          this.exec(input.buildCommand, input.repoPath, 300_000)
          this.log("info", "Build OK após npm install (lockfile regenerado)")
        } catch (recoveryError) {
          const recoveryMsg = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          // P1: build continua vermelho mesmo após recuperação de lockfile —
          // confirmar via stash se a falha independe das alterações do agente.
          if (input.subtask && (await this.handleIndependentGateFailure(input, input.subtask, input.buildCommand, recoveryMsg, "Build vermelho após npm install"))) {
            return { kind: "baseline_correction_created" }
          }
          throw new Error("Build falhou (mesmo após npm install): " + recoveryMsg.substring(0, 500), { cause: recoveryError })
        }
      } else {
        // P1 (Alexandre 2026-09-05): confirmar via git stash se o build falha
        // MESMO SEM as alterações do agente (baseline vermelho). Se sim, não é
        // culpa do agente: cria correção de baseline (alta confiança) ou bloqueia.
        if (input.subtask && (await this.handleIndependentGateFailure(input, input.subtask, input.buildCommand, msg, "Build vermelho independente das alterações do agente"))) {
          return { kind: "baseline_correction_created" }
        }
        throw new Error("Build falhou: " + msg.substring(0, 500), { cause: error })
      }
    }

    const correctionFingerprint = input.subtask?.correctionFingerprint
    const isBaselineFix = isBaselineCorrection(correctionFingerprint)
    // Decisão 2026-09-04 (Alexandre): specs funcionais (*.functional.spec.ts)
    // usam MySQL real + seed e não são gate automático — nem no baseline,
    // nem no gate escopado, nem na correção de baseline. Ficam para
    // humanos/CI via `npm run test` completo.
    let command = withBaselineExcludes(input.testCommand)
    let scopeLabel = "suíte completa (sem specs funcionais)"

    if (!isBaselineFix) {
      try {
        const changed = this.listChangedPaths(input.repoPath)
        const decision = decideGateScope(changed, this.listTestFiles(input.repoPath))
        if (decision.kind === "skip") {
          this.log("info", "Gate escopado: " + decision.reason)
          return { kind: "verified" }
        }
        if (decision.kind === "scoped") {
          const gateFiles = decision.files.filter((file) => !isFunctionalSpec(file))
          const excluded = decision.files.length - gateFiles.length
          if (gateFiles.length === 0) {
            this.log("info", `Gate escopado: apenas specs funcionais afetadas (${excluded}); testes pulados — gate automático não cobre testes de ambiente real`)
            return { kind: "verified" }
          }
          if (input.testCommand.startsWith("npm run test")) {
            const quoted = gateFiles.map((file) => `"${file}"`).join(" ")
            command = input.testCommand + " -- " + quoted
            scopeLabel = decision.reason + (excluded > 0 ? ` (${excluded} spec funcional excluída do gate automático)` : "")
          } else {
            this.log("warn", "Comando de teste não suporta filtro de arquivos; rodando suíte completa (sem specs funcionais)")
          }
        } else {
          this.log("info", "Gate escopado: " + decision.reason)
        }
      } catch (error) {
        this.log("warn", "Falha ao escopar o gate (" + (error instanceof Error ? error.message : String(error)) + "); rodando suíte completa (sem specs funcionais)")
      }
    }

    this.log("info", `Executando testes (${scopeLabel}): ` + command)
    try {
      this.exec(command, input.repoPath, 300_000)
      this.log("info", "Testes OK")
      return { kind: "verified" }
    } catch (error) {
      const firstFailure = error instanceof Error ? error.message : String(error)
      // Confirma a falha no workspace intocado. Flake não consome uma entrega
      // nem envia o programador para "corrigir" um teste que já voltou a passar.
      const confirmationCommand = confirmationTestCommand(command, firstFailure)
      this.log("warn", "Gate vermelho; confirmando falha no workspace intocado: " + confirmationCommand)
      try {
        this.exec(confirmationCommand, input.repoPath, 300_000)
        this.log("warn", "Teste passou na repetição sem alteração do workspace; falha classificada como flaky")
        return { kind: "verified" }
      } catch (confirmationError) {
        const confirmedFailure = confirmationError instanceof Error ? confirmationError.message : String(confirmationError)
        // P1 (Alexandre 2026-09-05): a "confirmação" acima ainda roda COM as
        // alterações do agente aplicadas. Aqui o motor faz git stash das
        // alterações e re-executa: se a falha persiste SEM o código do agente,
        // é baseline vermelho/ambiente — cria correção de baseline (caso de
        // alta confiança) ou bloqueia (ambiente/correção já em curso), em vez
        // de queimar entregas num gate impossível.
        if (input.subtask && (await this.handleIndependentGateFailure(input, input.subtask, confirmationCommand, firstFailure + "\n--- confirmação ---\n" + confirmedFailure, "Teste vermelho independente das alterações do agente"))) {
          return { kind: "baseline_correction_created" }
        }
        throw new Error(
          "Testes falharam em duas execuções consecutivas.\n" +
          "--- primeira execução ---\n" + firstFailure + "\n" +
          "--- confirmação ---\n" + confirmedFailure,
          { cause: confirmationError },
        )
      }
    }
  }

  /**
   * P1 (decisão Alexandre 2026-09-05 — correção híbrida, opção c): confirma
   * via git stash se a falha do gate existe MESMO SEM as alterações do agente.
   *
   * - Falha ambiental (conexão, binário ausente...) → bloqueio `blocked_environment`.
   * - Baseline vermelho durante a própria correção de baseline → bloqueio
   *   `correction_failed` (anti-loop: nunca gera correção de correção).
   * - Baseline vermelho de alta confiança (falha provada sem o código do
   *   agente) → subtarefa de correção automática (reaproveita o mecanismo do
   *   runBaselineCheck); retorna true para o caller adiar a subtarefa original.
   * - Falha depende das alterações → retorna false (rejeição normal do agente).
   */
  private async handleIndependentGateFailure(
    input: WorkerInput,
    subtask: SubtaskInfo,
    confirmationCommand: string,
    failureText: string,
    where: string,
  ): Promise<boolean> {
    if (!this.db) return false
    let confirmation
    try {
      confirmation = confirmBaselineIndependentFailure({
        repoPath: input.repoPath,
        confirmationCommand,
        runner: (command, cwd, timeoutMs) => this.exec(command, cwd, timeoutMs),
        timeoutMs: 300_000,
      })
    } catch (error) {
      // Worktree inconsistente (stash pop falhou): bloqueio ambiental — nunca
      // atribuir ao agente.
      const reason = error instanceof Error ? error.message : String(error)
      await this.recordBlocker(subtask, "blocked_environment", reason)
      throw new Error(reason)
    }
    if (!confirmation.baselineRed) {
      this.log("info", "Confirmação via stash: " + confirmation.evidence)
      return false
    }
    const evidence = where + ": " + confirmation.evidence + "\n" + digestGateFailure(failureText, { maxLines: 30, maxChars: 3500 })
    if (confirmation.kind === "environment") {
      const reason = "Ambiente bloqueado (gate falha mesmo sem alterações do agente; causa ambiental): " + evidence
      this.log("error", reason.substring(0, 500))
      await this.recordBlocker(subtask, "blocked_environment", reason)
      throw new Error(reason)
    }
    if (isBaselineCorrection(subtask.correctionFingerprint)) {
      const reason = "Baseline continua vermelho durante a subtarefa de correção de baseline — intervenção humana necessária: " + evidence
      this.log("error", reason.substring(0, 500))
      await this.recordBlocker(subtask, "correction_failed", reason)
      throw new Error(reason)
    }
    this.log("warn", "Baseline vermelho confirmado via stash (alta confiança): criando correção automática — " + where)
    await this.recordDeliveryEvent(subtask.id, subtask.deliverCount, undefined, "baseline_red", evidence.substring(0, 2000))
    await this.createBaselineCorrection(subtask, evidence.substring(0, 2000))
    return true
  }

  /** Caminhos alterados no workspace (git status --porcelain, incluindo não rastreados). */
  private listChangedPaths(repoPath: string): string[] {
    const status = this.exec("git status --porcelain", repoPath, 60_000).trim()
    if (!status) return []
    return status
      .split("\n")
      .map((line) => {
        const raw = line.slice(3).trim()
        const arrow = raw.indexOf(" -> ")
        const path = arrow === -1 ? raw : raw.slice(arrow + 4)
        return path.replace(/^"|"$/g, "").trim()
      })
      .filter((path) => path.length > 0 && !path.includes("\"") && !path.includes("'"))
  }

  /** Todos os arquivos de teste conhecidos do repositório + testes novos não rastreados. */
  private listTestFiles(repoPath: string): string[] {
    const listed = this.exec("git ls-files", repoPath, 60_000)
      .split("\n")
      .map((line) => line.trim())
      .filter((path) => path.length > 0 && isTestPath(path))
    const changedTests = this.listChangedPaths(repoPath).filter((path) => isTestPath(path))
    return [...new Set([...listed, ...changedTests])]
  }

  /**
   * Baseline (2026-08-31): antes da primeira subtarefa de uma tarefa (nenhuma
   * verificada ainda), roda build + suíte completa na branch-base LIMPA. Se
   * estiver vermelha, cria subtarefa de correção de baseline na mesma posição
   * e adia a subtarefa original — em vez de queimar tentativas num gate
   * impossível.
   */
  private async runBaselineCheck(input: WorkerInput, subtask: SubtaskInfo): Promise<"ok" | "correction_created"> {
    if (!this.db) return "ok"
    if (isBaselineCorrection(subtask.correctionFingerprint)) return "ok"
    const [rows] = await this.db.query(
      "SELECT COUNT(*) AS total FROM subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM subtarefas WHERE id = ?) AND status = 'verified'",
      [subtask.id],
    ) as unknown as [Array<{ total: number | string }>]
    if (Number(rows[0]?.total ?? 0) > 0) return "ok"

    this.send({ type: "progress", executionId: input.context.executionId, phase: "execute", message: "Baseline: validando suíte na branch-base" })
    const baselineTestCommand = withBaselineExcludes(input.testCommand)
    this.log("info", "Baseline: rodando build + suíte na branch-base antes da primeira subtarefa: " + baselineTestCommand)
    try {
      this.exec(input.buildCommand, input.repoPath, 300_000)
      this.exec(baselineTestCommand, input.repoPath, 300_000)
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).substring(0, 2000)
      await this.createBaselineCorrection(subtask, reason)
      return "correction_created"
    }
    this.log("info", "Baseline verde")
    return "ok"
  }

  /** Cria a subtarefa de correção de baseline na posição da subtarefa original. */
  private async createBaselineCorrection(subtask: SubtaskInfo, reason: string): Promise<void> {
    if (!this.db) throw new Error("DB não conectado para criar correção de baseline")
    // A coluna correction_fingerprint é varchar(500). O prefixo + o fingerprint
    // normalizado precisam caber juntos — senão o INSERT falha com "Data too long".
    const fingerprint = (BASELINE_FINGERPRINT_PREFIX + failureFingerprint(reason)).slice(0, 500)
    // Abre espaço na posição exata da subtarefa atual (seq -> seq+1 para >= seq).
    await this.db.query("UPDATE subtarefas SET seq = seq + 10000 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM subtarefas WHERE id = ?) AS source) AND seq >= ?", [subtask.id, subtask.seq])
    await this.db.query("UPDATE subtarefas SET seq = seq - 9999 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM subtarefas WHERE id = ?) AS source) AND seq >= ?", [subtask.id, subtask.seq + 10000])
    await this.db.query(
      "UPDATE subtarefas SET status = 'rejected', resultado = ?, updated_at = NOW() WHERE id = ?",
      [("Baseline vermelho — correção automática criada: " + reason).substring(0, 500), subtask.id],
    )
    await this.db.query(
      "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_for_subtask_id, correction_fingerprint, created_at, updated_at) " +
      "SELECT tarefa_id, ?, ?, ?, JSON_ARRAY(?), 'pending', id, ?, NOW(), NOW() FROM subtarefas WHERE id = ?",
      [subtask.seq, BASELINE_CORRECTION_TITLE, baselineCorrectionScope(reason, subtask.scope, subtask.titulo), BASELINE_CORRECTION_CRITERION, fingerprint, subtask.id],
    )
    this.log("warn", "Baseline vermelho: subtarefa de correção criada na posição da subtarefa " + subtask.id)
  }

  /**
   * Cria o commit técnico somente depois do gate verde. O commit ocorre no
   * worktree exclusivo; o repositório principal nunca sofre checkout, merge
   * ou escrita nesta etapa.
   */
  private async phaseCommit(input: WorkerInput): Promise<string | undefined> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "commit", message: "Registrando entrega aprovada" })
    const status = this.exec("git status --porcelain", input.repoPath).trim()
    if (!status) {
      this.log("info", "Gate verde sem alterações pendentes; commit não necessário")
      return undefined
    }

    this.exec("git add -A", input.repoPath)
    const subtask = input.subtask
    const message = `motor-v2: tarefa ${input.task.id}, subtarefa ${subtask?.id ?? "n/a"}`
    try {
      execFileSync("git", ["commit", "--no-verify", "-m", message], {
        cwd: input.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      })
    } catch (error) {
      const details = error as { stderr?: Buffer; message?: string }
      throw new Error("Commit técnico falhou: " + (details.stderr?.toString() || details.message || String(error)).substring(0, 500), { cause: error })
    }
    const commit = this.exec("git rev-parse --verify HEAD", input.repoPath).trim()
    this.log("info", "Entrega aprovada registrada no commit " + commit)
    return commit
  }

  /**
   * FASE 5: PUBLISH - Publica somente o commit aprovado na branch de trabalho.
   * Merge, deploy e limpeza do workspace permanecem fora desta etapa.
   */
  private async phasePublish(input: WorkerInput, commitSha: string): Promise<void> {
    const workBranch = input.workBranch || "motor-v2/task-" + input.task.id
    if (!isSafeBranchName(workBranch)) {
      throw new Error("Branch de trabalho inválida para publicação")
    }
    if (!/^[a-f0-9]{7,40}$/i.test(commitSha)) {
      throw new Error("Commit inválido para publicação")
    }

    this.send({
      type: "progress",
      executionId: input.context.executionId,
      phase: "publish",
      message: `Publicando branch ${workBranch}`,
    })

    try {
      execFileSync("git", ["push", "--set-upstream", "origin", `${commitSha}:refs/heads/${workBranch}`], {
        cwd: input.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      })
    } catch (error) {
      const details = error as { stderr?: Buffer; message?: string }
      throw new Error(
        "Publicação da branch falhou: " +
          (details.stderr?.toString() || details.message || String(error)).substring(0, 500),
        { cause: error },
      )
    }

    this.log("info", `Branch ${workBranch} publicada com sucesso`)
  }

  // === HELPERS ===

  private createDriver(): ConsoleAgentRuntimeDriver {
    const baseUrl = process.env.OPENCLAW_CONSOLE_URL
    const token = process.env.OPENCLAW_CONSOLE_TOKEN
    if (!baseUrl || !token) throw new Error("OPENCLAW_CONSOLE_URL e OPENCLAW_CONSOLE_TOKEN sao obrigatorios")
    return new ConsoleAgentRuntimeDriver({ baseUrl, token })
  }

  private async resolveManagedPrompt(key: string, values: Record<string, unknown>, fallback: string, taskId?: string, subtaskId?: number): Promise<string> {
    if (!this.db) return fallback
    return new ManagedPromptResolver(this.db).resolve({ key, values, fallback, taskId, subtaskId })
  }

  /** Adapta a conexão exclusiva do worker à transação atômica do plano. */
  private planningDb(): Db {
    const connection = this.db
    if (!connection) throw new Error("DB não conectado para persistir plano")

    const db: Db = {
      query: async (sql: string, params?: unknown[]): Promise<QueryResult> => {
        const [rows] = await connection.execute(sql, params as mysql.ExecuteValues | undefined)
        if (Array.isArray(rows)) return { rows: rows as Record<string, unknown>[], affectedRows: 0, insertId: 0 }
        const result = rows as { affectedRows?: number; insertId?: number }
        return { rows: [], affectedRows: result.affectedRows ?? 0, insertId: result.insertId ?? 0 }
      },
      transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
        await connection.beginTransaction()
        try {
          const result = await fn(db)
          await connection.commit()
          return result
        } catch (error) {
          await connection.rollback()
          throw error
        }
      },
    }
    return db
  }

  private buildAnalystPrompt(task: { title: string; description?: string; tipo?: string }, clarificationHistory?: string): string {
    const lightweight = task.tipo === "automacao" || task.tipo === "verificacao"
    const lines = [
      lightweight
        ? "Voce e um analista de requisitos. Recebe uma tarefa operacional e deve quebra-la em subtarefas executaveis pelo agente."
        : "Voce e um analista de requisitos. Recebe uma tarefa e deve quebra-la em subtarefas.",
      "",
      "Tarefa: " + task.title,
      "Descricao: " + truncateDescriptionForAnalyst(task.description),
      "",
      "Responda APENAS com JSON valido, em UMA das duas formas abaixo.",
      "",
      "Forma 1 — quando a definicao estiver clara o suficiente, o plano:",
      "{",
      '  "subtarefas": [',
      "    {",
      '      "seq": 1,',
      '      "titulo": "Nome da subtarefa",',
      '      "scope": "O que deve ser feito em detalhes",',
      '      "acceptance_criteria": ["criterio 1", "criterio 2"]',
      "    }",
      "  ]",
      "}",
      "",
      "Forma 2 — quando houver ambiguidade que impeca um plano correto (escopo, objetivo, criterios, conflito de requisitos, decisao de arquitetura), NAO invente e NAO gere um plano ruim; pergunte:",
      "{",
      '  "kind": "perguntas",',
      '  "resumo": "o que voce JA entendeu da tarefa",',
      '  "perguntas": ["pergunta 1", "pergunta 2"]',
      "}",
      "",
      "Regras:",
      lightweight
        ? "- Gere no MINIMO 1 subtarefa. Para tarefas simples, gere exatamente 1; divida somente se a complexidade exigir, sem passar de 10. Reescreva o pedido de forma precisa e executavel."
        : "- Quebre a tarefa no MINIMO de subtarefas possivel (a partir de 2). Crie mais somente quando a complexidade exigir de fato (ex.: muitas telas, modulos independentes), sem passar de 10. Prefira sempre menos subtarefas bem definidas a muitas picotadas.",
      "- titulo: curto, ate ~80 caracteres.",
      "- scope: objetivo, ate ~500 caracteres. O programador ja recebe a descricao completa da tarefa na execucao; NAO repita a especificacao nem a descricao da tarefa no scope.",
      "- acceptance_criteria: 2 a 4 itens curtos.",
      "- Mantenha a resposta curta: responda APENAS o JSON, sem explicacao fora dele.",
      "- NUNCA crie subtarefas para passos operacionais que o motor executa automaticamente: commit, push, merge, build, testes unitarios, deploy, validacao de build.",
      lightweight
        ? "- Em automacao/verificacao, a subtarefa deve descrever a acao ou verificacao concreta, os dados/recursos a usar e o formato da resposta. Nao crie trabalho de codigo, workspace, branch, build ou testes."
        : "- Subtarefas devem conter apenas trabalho de codigo ou documentacao (ex.: criar schema, criar tela, escrever endpoint).",
      "- Se o escopo incluir criacao de tabelas/schema, o proprio dev deve gerar as migrations (drizzle-kit generate) como parte do trabalho — mas NAO crie subtarefa separada para isso.",
      "",
      "Regras para SETUP DE PROJETO NOVO (quando a tarefa for setup de um projeto novo na plataforma):",
      "- TELAS PERSONALIZADAS (kind: custom no config.ts) NUNCA sao subtarefas do setup. Elas viram TAREFAS VINCULADAS AO PROJETO NOVO (com auto_start=true), executadas pelo agente do projeto novo (nao pelo biblioteca-global que fez o setup).",
      "- O setup do projeto deve APENAS: criar estrutura, config, schema, migrations, registros obrigatorios (schema-registry, front registry, seed, Dockerfiles, lockfile), e agente no gateway. NAO inclua implementacao de telas custom nas subtarefas do setup.",
      "- Se a descricao mencionar telas personalizadas, telas custom, dashboards custom, ou funcionalidades alem do CRUD padrao, IGNORE-as no plano de subtarefas do setup — elas serao tratadas como tarefas separadas pelo motor.",
      "- Subtarefas do setup devem focar em: estrutura de pastas, config.ts, schema.ts, migrations, registros nos Dockerfiles e registries, seed de dados iniciais, e registro do agente no gateway.",
      "- SMOKE TEST OBRIGATORIO: a ULTIMA subtarefa do setup DEVE ser 'Smoke test funcional do projeto novo'. Ela executa uma chamada HTTP real (curl) a um endpoint CRUD do projeto novo (GET /api/<slug>/...) e grava a evidencia no resultado: {\"smoke_test\":{\"url\":\"...\",\"method\":\"GET\",\"status\":200,\"response_body\":\"...\",\"timestamp\":\"...\"}}. O gate do motor REPROVA sem essa evidencia.",
      "",
      "Regras da clarificacao (Forma 2):",
      "- O campo \"resumo\" e obrigatorio: descreva o que voce ja entendeu.",
      "- Prefira perguntas decisorias (ex.: \"prefere A ou B?\"), mas perguntas abertas sao permitidas quando necessario.",
      "- No maximo 8 perguntas por turno; cada uma direta e especifica.",
      "- Nao pergunte o que ja esta respondido no historico abaixo.",
      "- Sem limite de turnos: se a resposta recebida ainda deixar ambiguidade relevante, pergunte de novo; so gere o plano quando a definicao estiver clara.",
    ]
    if (clarificationHistory) {
      lines.push(
        "",
        "HISTORICO DE CLARIFICACAO (perguntas anteriores e respostas recebidas):",
        clarificationHistory,
        "",
        "Considere este historico: nao repita perguntas ja respondidas. Se as respostas tornaram a definicao clara, responda com o plano (Forma 1).",
      )
    }
    return lines.join("\n")
  }

  /**
   * Monta a missão do programador. Se o briefing ultrapassar 12k chars,
   * retorna em duas partes (header + contexto) para evitar truncamento
   * no viewer da sessão do agente.
   */
  private buildProgrammerPrompt(task: { title: string; description?: string; tipo?: string }, subtask: SubtaskInfo, repoPath: string, reworkNote?: string, carryOver?: string): { header: string; context: string | null } {
    const description = task.description || "N/A"
    const lightweight = task.tipo === "automacao" || task.tipo === "verificacao"
    const header = [
      lightweight
        ? "Voce e um agente operacional senior. Execute a subtarefa abaixo usando suas proprias ferramentas e recursos disponiveis."
        : "Voce e um programador senior. Execute a subtarefa abaixo.",
      "",
      "Tarefa pai: " + task.title,
      "Subtarefa #" + subtask.seq + ": " + subtask.titulo,
      "Escopo: " + (subtask.scope || subtask.titulo),
      "Criterios de aceite: " + JSON.stringify(subtask.acceptanceCriteria || []),
      ...(lightweight ? ["Fluxo: " + task.tipo + " (sem workspace, branch, clone, build ou testes)"] : ["Workspace: " + repoPath]),
      "",
      "Instrucoes:",
      lightweight ? "1. Execute a acao/verificacao solicitada e produza uma resposta clara com as evidencias encontradas" : "1. Faca as alteracoes necessarias nos arquivos",
      "2. Nao faca commit (o motor faz depois)",
      lightweight
        ? "3. Responda APENAS com JSON: {\"status\":\"done\"|\"need_help\"|\"blocked_environment\",\"summary\":\"resposta final detalhada\",\"reason\":\"...\"}"
        : "3. Responda APENAS com JSON: {\"status\":\"done\"|\"need_help\"|\"blocked_environment\"|\"premise_incorrect\",\"summary\":\"...\",\"reason\":\"...\"}",
      ...(lightweight ? [] : ["4. Use premise_incorrect somente se a missão contradizer o repositório. Inclua claim, conflict_type, evidence:[{path,observation}] e suggested_revision; caminhos devem existir no workspace."]),
      ...(carryOver ? ["", carryOver] : []),
      ...(reworkNote ? ["", "Feedback do gate anterior:", digestGateFailure(reworkNote, { maxLines: 50, maxChars: 7000 })] : []),
    ].join("\n")

    // Descrição longa → mensagem separada para evitar truncamento no viewer
    if (description.length > 12000) {
      return { header, context: "Descrição completa da missão:\n\n" + description.substring(0, 30000) }
    }
    // Descrição curta → incluir no header
    const fullHeader = header.replace(
      "Voce e um programador senior. Execute a subtarefa abaixo.",
      "Voce e um programador senior. Execute a subtarefa abaixo.\n\nDescrição da missão: " + description.substring(0, 12000),
    )
    return { header: fullHeader, context: null }
  }

  /**
   * P1: histórico estruturado de entregas anteriores da subtarefa (carry-over
   * de aprendizado). Fail-open: sem histórico ou com erro de consulta, o
   * prompt segue sem a seção.
   */
  private async buildCarryOver(subtask: SubtaskInfo): Promise<string> {
    if (!this.db || subtask.deliverCount <= 0) return ""
    try {
      const [rows] = await this.db.query(
        "SELECT deliver_number, model, event_type, reason FROM subtarefas_entregas WHERE subtarefa_id = ? ORDER BY id ASC LIMIT 60",
        [subtask.id],
      ) as unknown as [Array<{ deliver_number: number | string; model: string | null; event_type: string; reason: string | null }>]
      const events: CarryOverEvent[] = rows.map((row) => ({
        deliverNumber: Number(row.deliver_number ?? 0),
        model: row.model == null ? null : String(row.model),
        eventType: String(row.event_type ?? ""),
        reason: row.reason == null ? null : String(row.reason),
      }))
      return formatCarryOver(events)
    } catch (error) {
      this.log("warn", "Falha ao carregar histórico de entregas (carry-over ignorado): " + (error instanceof Error ? error.message : String(error)))
      return ""
    }
  }

  /** Resumo estruturado da resposta do agente (campo `summary` do JSON). */
  private extractAgentSummary(content?: string): string | null {
    if (!content) return null
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0]) as { summary?: unknown }
      if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim().substring(0, 800)
    } catch { /* resposta em texto livre não tem summary estruturado */ }
    return null
  }

  private chainFor(input: WorkerInput, phase: "analysis" | "development"): readonly ModelSelection[] {
    return input.modelChain && input.modelChain.length > 0 ? input.modelChain : defaultChain(phase)
  }

  private classifyAgentOutcome(content?: string): { kind: "done" } | { kind: "need_help" | "blocked_environment"; reason: string } | { kind: "premise_incorrect"; payload: unknown } {
    if (!content) return { kind: "done" }
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return { kind: "done" }
    try {
      const parsed = JSON.parse(match[0]) as { status?: string; reason?: string; summary?: string }
      if (parsed.status === "need_help" || parsed.status === "blocked_environment") {
        return { kind: parsed.status, reason: parsed.reason || parsed.summary || parsed.status }
      }
      if (parsed.status === "premise_incorrect") return { kind: "premise_incorrect", payload: parsed }
    } catch { /* resposta legada em texto continua compatível */ }
    return { kind: "done" }
  }

  private async rebriefRefutedSubtask(input: WorkerInput, subtask: SubtaskInfo, refutation: PremiseRefutation): Promise<{ title: string; scope: string; criteria: string[] }> {
    const fallback = { title: `${subtask.titulo} (revisão)`, scope: refutation.suggestedRevision, criteria: subtask.acceptanceCriteria ?? [] }
    for (const selection of defaultChain("analysis")) {
      const driver = this.createDriver()
      let session
      try {
        session = await driver.createSession({ agentId: input.task.agentId, key: formatSessionKey({ agentId: input.task.agentId, taskId: input.task.id, phase: "analysis", model: selection.model, modelIndex: 0, generation: 1 }), label: `rebrief:${input.task.id}:${subtask.id}`, model: selection.model })
        const embedded = [
          "Você é o analista. A premissa de uma subtarefa foi refutada com evidência validada.",
          `Tarefa: ${input.task.title}`,
          `Subtarefa original: ${subtask.titulo}\n${subtask.scope ?? ""}`,
          `Refutação: ${refutation.claim}`,
          `Evidências: ${JSON.stringify(refutation.evidence)}`,
          `Sugestão do executor: ${refutation.suggestedRevision}`,
          'Responda APENAS com JSON: {"titulo":"...","scope":"...","acceptance_criteria":["..."]}',
        ].join("\n\n")
        const prompt = await this.resolveManagedPrompt("analista.revisao_premissa_incorreta", {
          "**TEXTOTAREFA**": input.task.title,
          "**TEXTOSUBTAREFAORIGINAL**": `${subtask.titulo}\n${subtask.scope ?? ""}`,
          "**ERROREPORTADOPELOAGENTEDEV**": refutation.claim,
          "**EVIDENCIASREFUTACAO**": refutation.evidence,
        }, embedded, input.task.id, subtask.id)
        const sent = await driver.sendMessage({ session, message: prompt })
        const result = await driver.waitForRunCompletion(session, sent.runId, { onActivity: () => this.sendHeartbeat() })
        const match = result.content?.match(/\{[\s\S]*\}/)
        if (!match) continue
        const parsed = JSON.parse(match[0]) as { titulo?: unknown; scope?: unknown; acceptance_criteria?: unknown }
        if (typeof parsed.titulo === "string" && typeof parsed.scope === "string" && Array.isArray(parsed.acceptance_criteria)) {
          return { title: parsed.titulo.slice(0, 200), scope: parsed.scope, criteria: parsed.acceptance_criteria.filter((item): item is string => typeof item === "string").slice(0, 6) }
        }
      } catch (error) {
        this.log("warn", "Rebriefing pelo analista indisponível; usando revisão sugerida e auditada: " + (error instanceof Error ? error.message : String(error)))
      } finally { if (session) await driver.closeSession(session).catch(() => {}) }
    }
    return fallback
  }

  private async replaceRefutedSubtask(subtask: SubtaskInfo, refutation: PremiseRefutation, fingerprint: string, model: string, revised: { title: string; scope: string; criteria: string[] }): Promise<void> {
    if (!this.db) throw new Error("DB não conectado para revisar subtarefa")
    const [rows] = await this.db.query("SELECT tarefa_id, revision, rebrief_count, premise_fingerprint, acceptance_criteria FROM subtarefas WHERE id = ?", [subtask.id]) as unknown as [Array<Record<string, unknown>>]
    const row = rows[0]
    if (!row) throw new Error("Subtarefa refutada não encontrada")
    const rebriefCount = Number(row.rebrief_count ?? 0)
    if (rebriefCount >= 2 || row.premise_fingerprint === fingerprint) {
      const reason = "Limite de revisões automáticas ou refutação repetida; decisão humana necessária"
      await this.recordBlocker(subtask, "systemic_failure", reason, model)
      throw new Error(reason)
    }
    await this.db.beginTransaction()
    try {
      const [insert] = await this.db.query(
        "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, revision, replaces_subtask_id, rebrief_count, premise_fingerprint, premise_evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NOW(), NOW())",
        [Number(row.tarefa_id), subtask.seq, revised.title, revised.scope, JSON.stringify(revised.criteria), Number(row.revision ?? 0) + 1, subtask.id, rebriefCount + 1, fingerprint, JSON.stringify(refutation)],
      ) as unknown as [{ insertId: number }]
      const replacementId = Number(insert.insertId)
      await this.db.query("UPDATE subtarefas SET status = 'superseded', superseded_by_subtask_id = ?, rebrief_count = ?, premise_fingerprint = ?, premise_evidence = ?, resultado = ?, finalizada_em = NOW(), updated_at = NOW() WHERE id = ?", [replacementId, rebriefCount + 1, fingerprint, JSON.stringify(refutation), `Premissa refutada: ${refutation.claim}`, subtask.id])
      await this.db.query("INSERT INTO subtarefas_entregas (subtarefa_id, deliver_number, model, event_type, reason, created_at) VALUES (?, ?, ?, 'premise_refuted', ?, NOW())", [subtask.id, subtask.deliverCount, model, JSON.stringify(refutation)])
      await this.db.commit()
    } catch (error) { await this.db.rollback(); throw error }
  }

  /**
   * MONITORAMENTO MOTOR: classifica a causa raiz da falha de gate consultando
   * a sessão fixa "Monitoramento Motor". Fail-open: se o classificador falhar,
   * retorna null e o fluxo normal continua.
   */
  private async classifyGateFailure(
    input: WorkerInput,
    subtask: SubtaskInfo,
    model: string,
    modelIndex: number,
    errorMessage: string
  ): Promise<GateFailureVerdict | null> {
    if (!this.db) return null

    try {
      // Contar ocorrências deste erro na subtarefa
      const [countRows] = await this.db.query(
        "SELECT COUNT(*) AS total FROM subtask_gate_failures WHERE subtarefa_id = ? AND fingerprint = ?",
        [subtask.id, failureFingerprint(errorMessage)]
      ) as unknown as [Array<{ total: number | string }>]
      const occurrence = Number(countRows[0]?.total ?? 0) + 1

      const driver = this.createDriver()
      const classifier = new GateFailureClassifier(driver, this.db)

      const result = await classifier.classify({
        taskId: input.task.id,
        subtaskId: subtask.id,
        subtaskTitle: subtask.titulo,
        subtaskScope: subtask.scope,
        acceptanceCriteria: subtask.acceptanceCriteria,
        taskTitle: input.task.title,
        agentId: input.task.agentId,
        projectSlug: input.context.projectSlug,
        repoPath: input.repoPath,
        model,
        modelIndex,
        occurrence,
        errorMessage,
        command: input.buildCommand, // Comando que falhou (build ou teste)
      })

      if (result.kind === "verdict") {
        return result.verdict
      }

      this.log("warn", `Classificador indisponível: ${result.error}`)
      return null
    } catch (error) {
      this.log("warn", `Falha ao classificar falha de gate: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private async recordBlocker(subtask: SubtaskInfo, kind: BlockerKind, reason: string, model?: string): Promise<void> {
    if (!this.db) throw new Error("DB não conectado para registrar bloqueio")
    const evidence = blockerEvidence(kind, reason)
    await this.db.query(
      "INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
      "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM subtarefas WHERE id = ?",
      [subtask.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtask.id],
    )
    this.log("warn", "Bloqueio persistido: " + evidence.kind + " (" + evidence.fingerprint + ")")
    // Registra evento de bloqueio no histórico de entregas
    await this.recordDeliveryEvent(subtask.id, subtask.deliverCount, model, "blocked", reason)
  }

  /**
   * Registra um evento no histórico de entregas da subtarefa.
   * Cada evento (entrega iniciada, gate rejeitado, retorno para rework, bloqueio, conclusão)
   * grava uma linha nova — nunca sobrescreve o histórico anterior.
   */
  private async recordDeliveryEvent(
    subtaskId: number,
    deliverNumber: number,
    model: string | undefined,
    eventType: "delivery_started" | "gate_rejected" | "return_for_rework" | "blocked" | "completed" | "baseline_red",
    reason: string | null,
  ): Promise<void> {
    if (!this.db) return
    try {
      await this.db.query(
        "INSERT INTO subtarefas_entregas (subtarefa_id, deliver_number, model, event_type, reason, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
        [subtaskId, deliverNumber, model ?? null, eventType, reason],
      )
    } catch (error) {
      this.log("warn", "Falha ao registrar evento de entrega: " + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async createCorrectionOnRepeatedGateFailure(input: WorkerInput, subtask: SubtaskInfo, model: string, reason: string): Promise<boolean> {
    if (!this.db) throw new Error("DB não conectado para registrar falha de gate")
    const fingerprint = failureFingerprint(reason)
    await this.db.query(
      "INSERT INTO subtask_gate_failures (subtarefa_id, fingerprint, reason, model) VALUES (?, ?, ?, ?)",
      [subtask.id, fingerprint, reason.slice(0, 4000), model],
    )
    const [rows] = await this.db.query(
      "SELECT COUNT(*) AS total FROM subtask_gate_failures WHERE subtarefa_id = ? AND fingerprint = ?",
      [subtask.id, fingerprint],
    ) as unknown as [Array<{ total: number | string }>]
    if (Number(rows[0]?.total ?? 0) !== 2) return false

    // Correção que falha repetidamente NÃO gera outra correção (sem corrente
    // infinita): bloqueia a tarefa inteira para intervenção humana.
    const [parentRows] = await this.db.query(
      "SELECT correction_for_subtask_id FROM subtarefas WHERE id = ?",
      [subtask.id],
    ) as unknown as [Array<{ correction_for_subtask_id: number | null }>]
    const correctionParentId = Number(parentRows[0]?.correction_for_subtask_id ?? 0)
    if (correctionParentId !== 0) {
      const blockReason = "Subtarefa de correção " + subtask.id + " falhou repetidamente (corrige a subtarefa " + correctionParentId + "): " + reason
      await this.recordBlocker(subtask, "correction_failed", blockReason, model)
      this.log("error", "Correção falhou — bloqueando a tarefa inteira: " + blockReason)
      throw new Error(blockReason)
    }

    const [claimed] = await this.db.query(
      "UPDATE subtarefas SET correction_created_at = NOW(), correction_fingerprint = ? WHERE id = ? AND correction_created_at IS NULL",
      [fingerprint, subtask.id],
    ) as unknown as [{ affectedRows: number }]
    if (claimed.affectedRows !== 1) return false
    await this.db.query("UPDATE subtarefas SET seq = seq + 10000 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq])
    await this.db.query("UPDATE subtarefas SET seq = seq - 9999 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq + 10000])
    await this.db.query(
      "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_for_subtask_id, correction_fingerprint, created_at, updated_at) " +
      "SELECT tarefa_id, ?, ?, CONCAT(?, CHAR(10), CHAR(10), 'Escopo original da subtarefa corrigida:', CHAR(10), IFNULL(scope, titulo)), acceptance_criteria, 'pending', id, ?, NOW(), NOW() FROM subtarefas WHERE id = ?",
      [subtask.seq + 1, "Correção: " + subtask.titulo, "Corrigir gate repetido: " + reason.slice(0, 1000), fingerprint, subtask.id],
    )
    // Registra retorno para rework no histórico da subtarefa original
    await this.recordDeliveryEvent(subtask.id, subtask.deliverCount, model, "return_for_rework", "Falha repetida no gate: " + reason.slice(0, 1000))
    this.log("warn", "Subtarefa de correção criada para falha repetida " + fingerprint + " (subtarefa " + subtask.id + ", corrige a original; tarefa bloqueia se a correção também falhar)")
    return true
  }

  private exec(command: string, cwd: string, timeoutMs = 30000): string {
    try {
      return execSync(command, { cwd, timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      throw new Error(formatCommandFailure(error as CommandFailure), { cause: error })
    }
  }

  private sendCompleted(context: ExecutionContext, result: ExecutionResult): void {
    this.send({ type: "completed", executionId: context.executionId, result })
    this.cleanup()
    setTimeout(() => process.exit(0), 1000)
  }

  /** Analista pediu esclarecimentos: encerra o worker sem falha. */
  private sendClarifying(context: ExecutionContext, info: { questionCount: number; summary?: string }): void {
    this.send({ type: "clarifying", executionId: context.executionId, questionCount: info.questionCount, summary: info.summary })
    this.cleanup()
    setTimeout(() => process.exit(0), 1000)
  }

  private sendFailed(context: ExecutionContext, error: string): void {
    this.send({ type: "failed", executionId: context.executionId, error })
    this.cleanup()
    setTimeout(() => process.exit(1), 1000)
  }

  private sendHeartbeat(): void {
    this.send({
      type: "heartbeat",
      executionId: this.executionId,
      cpuUsage: process.cpuUsage().user / 1000,
      memUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    })
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.send({ type: "log", executionId: this.executionId, level, message })
  }

  private send(msg: WorkerToCoordinatorMessage): void {
    if (process.send) process.send(msg)
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private shutdown(): void {
    this.log("info", "Shutdown")
    this.cleanup()
    process.exit(0)
  }
}

// Auto-start somente quando este arquivo É o processo principal (o
// WorkerLauncher o executa via `node TaskWorker.js`). Em imports (testes,
// re-export do index) o worker não pode disparar sozinho.
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMainModule) {
  const worker = new TaskWorker()
  worker.start().catch((error) => {
    console.error("[TaskWorker] Fatal:", error)
    process.exit(1)
  })
}

export { TaskWorker }
