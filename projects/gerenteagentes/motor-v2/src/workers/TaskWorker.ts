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
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import type { WorkerInput, ExecutionContext, ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from "./WorkerProtocol.js"
import { defaultChain, formatSessionKey, isModelUnavailableError, type ModelSelection } from "../policies/ModelTierPolicy.js"
import { isSystemicFailure } from "../policies/SystemFailurePolicy.js"
import { blockerEvidence, type BlockerKind } from "../policies/BlockerPolicy.js"
import { failureFingerprint } from "../policies/SystemFailurePolicy.js"
import { decideGateScope, isTestPath } from "../policies/GateScopePolicy.js"
import {
  BASELINE_CORRECTION_CRITERION,
  BASELINE_CORRECTION_TITLE,
  BASELINE_FINGERPRINT_PREFIX,
  baselineCorrectionScope,
  isBaselineCorrection,
  withBaselineExcludes,
} from "../policies/BaselinePolicy.js"
import { hasPersistedPlan, persistPlan } from "../planning/PlanPersistence.js"
import type { Db, QueryResult } from "../shared/types/infrastructure.js"
import mysql from "mysql2/promise"

const COMMAND_FAILURE_LIMIT = 12_000
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

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
      database: "projeto_640",
    })

    process.on("message", async (msg: unknown) => {
      await this.handleMessage(msg as CoordinatorToWorkerMessage)
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
        await this.phaseAnalyze(input)
      } else if (ctx.phase === "execute") {
        await this.phasePrepare(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        gitCommitSha = await this.phaseExecute(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        if (gitCommitSha) await this.phasePublish(input, gitCommitSha)
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
   * FASE 1: ANALYZE - Chama o Analista para criar subtarefas
   */
  private async phaseAnalyze(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "analyze", message: "Iniciando analise" })
    this.log("info", "Fase ANALYZE: " + input.task.title)

    const planningDb = this.planningDb()
    if (await hasPersistedPlan(planningDb, input.task.id)) {
      this.log("info", "Plano persistido encontrado; análise não será repetida")
      return
    }

    const driver = this.createDriver()
    const chain = this.chainFor(input, "analysis")
    const prompt = this.buildAnalystPrompt(input.task)

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
        this.log("info", "Resultado do analista: state=" + result.state + ", contentLength=" + (result.content?.length || 0))

        if (result.state !== "final" || !result.content) {
          lastFailure = "Analista falhou: " + (result.errorMessage || result.state)
          this.log("warn", lastFailure)
          continue
        }

        const subtarefas = this.parseAnalystResponse(result.content)
        this.log("info", "Analista criou " + subtarefas.length + " subtarefas")

        const persisted = await persistPlan(planningDb, input.task.id, subtarefas)
        if (persisted === "already_persisted") {
          this.log("info", "Plano foi persistido por outra execução; preservando-o")
        }
        this.log("info", "Fase ANALYZE concluida: " + subtarefas.length + " subtarefas criadas")
        return
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
   * FASE 2: PREPARE - Valida o worktree exclusivo criado pelo coordenador
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

    const baselineOutcome = await this.runBaselineCheck(input, subtask)
    if (baselineOutcome === "correction_created") {
      this.log("warn", "Baseline vermelho: subtarefa de correção criada; execução da subtarefa adiada")
      return undefined
    }

    const chain = this.chainFor(input, "development")
    // Uma retomada não pode apagar as entregas já registradas no banco.
    let deliverCount = subtask.deliverCount
    let lastFailure = ""
    const modelFailures: string[] = []

    modelLoop: for (let modelIndex = 0; modelIndex < chain.length; modelIndex += 1) {
      const model = chain[modelIndex]!
      for (let attempt = 1; attempt <= input.task.maxRework; attempt += 1) {
        deliverCount += 1
        await this.db!.query(
          "UPDATE projeto_640.subtarefas SET status = 'running', deliver_count = ?, resultado = NULL, updated_at = NOW() WHERE id = ?",
          [deliverCount, subtask.id],
        )
        this.send({ type: "progress", executionId: input.context.executionId, phase: "execute", message: `Entrega ${deliverCount}, modelo ${model.model}` })

        const driver = this.createDriver()
        const sessionKey = formatSessionKey({ agentId: input.task.agentId, taskId: input.task.id, phase: "development", model: model.model, modelIndex, generation: attempt - 1 })
        let session
        try {
          session = await driver.createSession({ agentId: input.task.agentId, key: sessionKey, label: sessionKey, model: model.model })
          const { header, context } = this.buildProgrammerPrompt(input.task, subtask, input.repoPath, lastFailure || undefined)
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
          const outcome = this.classifyAgentOutcome(result.content)
          if (outcome.kind === "blocked_environment") {
            const reason = "Ambiente bloqueado: " + outcome.reason
            await this.recordBlocker(subtask, "blocked_environment", reason)
            throw new Error(reason)
          }
          if (outcome.kind === "need_help") {
            lastFailure = outcome.reason
            break
          }

          let gitCommitSha: string | undefined
          try {
            await this.db!.query(
              "UPDATE projeto_640.subtarefas SET status = 'verifying', updated_at = NOW() WHERE id = ?",
              [subtask.id],
            )
            await this.phaseVerify(input)
            gitCommitSha = await this.phaseCommit(input)
          } catch (error) {
            lastFailure = error instanceof Error ? error.message : String(error)
            await this.db!.query(
              "UPDATE projeto_640.subtarefas SET status = 'rejected', resultado = ?, updated_at = NOW() WHERE id = ?",
              [lastFailure.substring(0, 500), subtask.id],
            )
            this.log("warn", `Gate vermelho (${model.model}, tentativa ${attempt}): ${lastFailure}`)
            if (await this.createCorrectionOnRepeatedGateFailure(input, subtask, model.model, lastFailure)) return undefined
            continue
          }

          await this.db!.query(
            "UPDATE projeto_640.subtarefas SET status = 'verified', deliver_count = ?, resultado = ?, finalizada_em = NOW(), updated_at = NOW() WHERE id = ?",
            [deliverCount, result.content?.substring(0, 500) || "OK", subtask.id],
          )
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

  /**
   * FASE 4: VERIFY - build + gate de testes.
   *
   * Gate escopado por subtarefa (2026-08-31): a suíte completa do monorepo
   * só roda quando a alteração toca configuração transversal ou quando a
   * subtarefa é uma correção de baseline; caso contrário rodam apenas os
   * testes afetados pelos caminhos alterados (ou nenhum, se não houver teste
   * afetado). Isso evita que testes flaky/alheios reprovem entregas simples.
   */
  private async phaseVerify(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "verify", message: "Verificando build e teste" })
    this.log("info", "Fase VERIFY: build + test")

    this.log("info", "Executando: " + input.buildCommand)
    try {
      this.exec(input.buildCommand, input.repoPath, 300_000)
      this.log("info", "Build OK")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error("Build falhou: " + msg.substring(0, 500), { cause: error })
    }

    const correctionFingerprint = input.subtask?.correctionFingerprint
    const isBaselineFix = isBaselineCorrection(correctionFingerprint)
    let command = input.testCommand
    let scopeLabel = "suíte completa"

    if (!isBaselineFix) {
      try {
        const changed = this.listChangedPaths(input.repoPath)
        const decision = decideGateScope(changed, this.listTestFiles(input.repoPath))
        if (decision.kind === "skip") {
          this.log("info", "Gate escopado: " + decision.reason)
          return
        }
        if (decision.kind === "scoped") {
          if (input.testCommand.startsWith("npm run test")) {
            const quoted = decision.files.map((file) => `"${file}"`).join(" ")
            command = input.testCommand + " -- " + quoted
            scopeLabel = decision.reason
          } else {
            this.log("warn", "Comando de teste não suporta filtro de arquivos; rodando suíte completa")
          }
        } else {
          this.log("info", "Gate escopado: " + decision.reason)
        }
      } catch (error) {
        this.log("warn", "Falha ao escopar o gate (" + (error instanceof Error ? error.message : String(error)) + "); rodando suíte completa")
      }
    }

    this.log("info", `Executando testes (${scopeLabel}): ` + command)
    try {
      this.exec(command, input.repoPath, 300_000)
      this.log("info", "Testes OK")
    } catch (error) {
      const firstFailure = error instanceof Error ? error.message : String(error)
      // Confirma a falha no workspace intocado. Flake não consome uma entrega
      // nem envia o programador para "corrigir" um teste que já voltou a passar.
      const confirmationCommand = confirmationTestCommand(command, firstFailure)
      this.log("warn", "Gate vermelho; confirmando falha no workspace intocado: " + confirmationCommand)
      try {
        this.exec(confirmationCommand, input.repoPath, 300_000)
        this.log("warn", "Teste passou na repetição sem alteração do workspace; falha classificada como flaky")
        return
      } catch (confirmationError) {
        const confirmedFailure = confirmationError instanceof Error ? confirmationError.message : String(confirmationError)
        throw new Error(
          "Testes falharam em duas execuções consecutivas.\n" +
          "--- primeira execução ---\n" + firstFailure + "\n" +
          "--- confirmação ---\n" + confirmedFailure,
          { cause: confirmationError },
        )
      }
    }
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
      "SELECT COUNT(*) AS total FROM projeto_640.subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AND status = 'verified'",
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
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq + 10000 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq >= ?", [subtask.id, subtask.seq])
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq - 9999 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq >= ?", [subtask.id, subtask.seq + 10000])
    await this.db.query(
      "UPDATE projeto_640.subtarefas SET status = 'rejected', resultado = ?, updated_at = NOW() WHERE id = ?",
      [("Baseline vermelho — correção automática criada: " + reason).substring(0, 500), subtask.id],
    )
    await this.db.query(
      "INSERT INTO projeto_640.subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_for_subtask_id, correction_fingerprint, created_at, updated_at) " +
      "SELECT tarefa_id, ?, ?, ?, JSON_ARRAY(?), 'pending', id, ?, NOW(), NOW() FROM projeto_640.subtarefas WHERE id = ?",
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

  private buildAnalystPrompt(task: { title: string; description?: string }): string {
    return [
      "Voce e um analista de requisitos. Recebe uma tarefa e deve quebra-la em subtarefas (2 a 4 no maximo).",
      "",
      "Tarefa: " + task.title,
      "Descricao: " + (task.description || "N/A"),
      "",
      "Responda APENAS com JSON valido:",
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
      "Regras:",
      "- Crie no maximo 4 subtarefas.",
      "- Seja especifico no scope.",
      "- Nao inclua explicacao fora do JSON.",
      "- NUNCA crie subtarefas para passos operacionais que o motor executa automaticamente: commit, push, merge, build, testes unitarios, deploy, validacao de build.",
      "- Subtarefas devem conter apenas trabalho de codigo ou documentacao (ex.: criar schema, criar tela, escrever endpoint).",
      "- Se o escopo incluir criacao de tabelas/schema, o proprio dev deve gerar as migrations (drizzle-kit generate) como parte do trabalho — mas NAO crie subtarefa separada para isso.",
    ].join("\n")
  }

  /**
   * Monta a missão do programador. Se o briefing ultrapassar 12k chars,
   * retorna em duas partes (header + contexto) para evitar truncamento
   * no viewer da sessão do agente.
   */
  private buildProgrammerPrompt(task: { title: string; description?: string }, subtask: SubtaskInfo, repoPath: string, reworkNote?: string): { header: string; context: string | null } {
    const description = task.description || "N/A"
    const header = [
      "Voce e um programador senior. Execute a subtarefa abaixo.",
      "",
      "Tarefa pai: " + task.title,
      "Subtarefa #" + subtask.seq + ": " + subtask.titulo,
      "Escopo: " + (subtask.scope || subtask.titulo),
      "Criterios de aceite: " + JSON.stringify(subtask.acceptanceCriteria || []),
      "Workspace: " + repoPath,
      "",
      "Instrucoes:",
      "1. Faca as alteracoes necessarias nos arquivos",
      "2. Nao faca commit (o motor faz depois)",
      "3. Responda APENAS com JSON: {\"status\":\"done\"|\"need_help\"|\"blocked_environment\",\"summary\":\"...\",\"reason\":\"...\"}",
      ...(reworkNote ? ["", "Feedback do gate anterior:", reworkNote] : []),
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

  private chainFor(input: WorkerInput, phase: "analysis" | "development"): readonly ModelSelection[] {
    return input.modelChain && input.modelChain.length > 0 ? input.modelChain : defaultChain(phase)
  }

  private classifyAgentOutcome(content?: string): { kind: "done" } | { kind: "need_help" | "blocked_environment"; reason: string } {
    if (!content) return { kind: "done" }
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return { kind: "done" }
    try {
      const parsed = JSON.parse(match[0]) as { status?: string; reason?: string; summary?: string }
      if (parsed.status === "need_help" || parsed.status === "blocked_environment") {
        return { kind: parsed.status, reason: parsed.reason || parsed.summary || parsed.status }
      }
    } catch { /* resposta legada em texto continua compatível */ }
    return { kind: "done" }
  }

  private parseAnalystResponse(content: string): Array<{ seq: number; titulo: string; scope?: string; acceptanceCriteria?: string[] }> {
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("Resposta do analista nao contem JSON")

    const parsed = JSON.parse(jsonMatch[0])
    const subtarefas = parsed.subtarefas
    if (!Array.isArray(subtarefas) || subtarefas.length === 0) {
      throw new Error("Analista nao retornou subtarefas")
    }

    return subtarefas.map((s: Record<string, unknown>, i: number) => ({
      seq: Number(s.seq ?? (i + 1)),
      titulo: String(s.titulo || "Subtarefa " + (i + 1)),
      scope: s.scope ? String(s.scope) : undefined,
      acceptanceCriteria: Array.isArray(s.acceptance_criteria) ? s.acceptance_criteria.map(String) : undefined,
    }))
  }

  private async recordBlocker(subtask: SubtaskInfo, kind: BlockerKind, reason: string): Promise<void> {
    if (!this.db) throw new Error("DB não conectado para registrar bloqueio")
    const evidence = blockerEvidence(kind, reason)
    await this.db.query(
      "INSERT INTO projeto_640.bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
      "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM projeto_640.subtarefas WHERE id = ?",
      [subtask.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtask.id],
    )
    this.log("warn", "Bloqueio persistido: " + evidence.kind + " (" + evidence.fingerprint + ")")
  }

  private async createCorrectionOnRepeatedGateFailure(input: WorkerInput, subtask: SubtaskInfo, model: string, reason: string): Promise<boolean> {
    if (!this.db) throw new Error("DB não conectado para registrar falha de gate")
    const fingerprint = failureFingerprint(reason)
    await this.db.query(
      "INSERT INTO projeto_640.subtask_gate_failures (subtarefa_id, fingerprint, reason, model) VALUES (?, ?, ?, ?)",
      [subtask.id, fingerprint, reason.slice(0, 4000), model],
    )
    const [rows] = await this.db.query(
      "SELECT COUNT(*) AS total FROM projeto_640.subtask_gate_failures WHERE subtarefa_id = ? AND fingerprint = ?",
      [subtask.id, fingerprint],
    ) as unknown as [Array<{ total: number | string }>]
    if (Number(rows[0]?.total ?? 0) !== 2) return false

    // Correção que falha repetidamente NÃO gera outra correção (sem corrente
    // infinita): bloqueia a tarefa inteira para intervenção humana.
    const [parentRows] = await this.db.query(
      "SELECT correction_for_subtask_id FROM projeto_640.subtarefas WHERE id = ?",
      [subtask.id],
    ) as unknown as [Array<{ correction_for_subtask_id: number | null }>]
    const correctionParentId = Number(parentRows[0]?.correction_for_subtask_id ?? 0)
    if (correctionParentId !== 0) {
      const blockReason = "Subtarefa de correção " + subtask.id + " falhou repetidamente (corrige a subtarefa " + correctionParentId + "): " + reason
      await this.recordBlocker(subtask, "correction_failed", blockReason)
      this.log("error", "Correção falhou — bloqueando a tarefa inteira: " + blockReason)
      throw new Error(blockReason)
    }

    const [claimed] = await this.db.query(
      "UPDATE projeto_640.subtarefas SET correction_created_at = NOW(), correction_fingerprint = ? WHERE id = ? AND correction_created_at IS NULL",
      [fingerprint, subtask.id],
    ) as unknown as [{ affectedRows: number }]
    if (claimed.affectedRows !== 1) return false
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq + 10000 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq])
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq - 9999 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq + 10000])
    await this.db.query(
      "INSERT INTO projeto_640.subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_for_subtask_id, correction_fingerprint, created_at, updated_at) " +
      "SELECT tarefa_id, ?, ?, CONCAT(?, CHAR(10), CHAR(10), 'Escopo original da subtarefa corrigida:', CHAR(10), IFNULL(scope, titulo)), acceptance_criteria, 'pending', id, ?, NOW(), NOW() FROM projeto_640.subtarefas WHERE id = ?",
      [subtask.seq + 1, "Correção: " + subtask.titulo, "Corrigir gate repetido: " + reason.slice(0, 1000), fingerprint, subtask.id],
    )
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
