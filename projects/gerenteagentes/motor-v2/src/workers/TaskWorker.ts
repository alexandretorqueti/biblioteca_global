/**
 * TaskWorker - Pipeline completo com 5 fases
 *
 * Fluxo:
 * 1. ANALYZE: Chama Analista -> cria subtarefas
 * 2. PREPARE: Confere branch base, cria branch de trabalho, checkout
 * 3. EXECUTE: Chama Programador com subtarefa
 * 4. VERIFY: npm run build + npm run test
 * 5. DEPLOY: Checkout base, merge, push, deploy.sh
 */

import { execFileSync, execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import type { WorkerInput, ExecutionContext, ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from "./WorkerProtocol.js"
import { defaultChain, formatSessionKey, isModelUnavailableError, type ModelSelection } from "../policies/ModelTierPolicy.js"
import { isSystemicFailure } from "../policies/SystemFailurePolicy.js"
import { blockerEvidence, type BlockerKind } from "../policies/BlockerPolicy.js"
import { failureFingerprint } from "../policies/SystemFailurePolicy.js"
import { hasPersistedPlan, persistPlan } from "../planning/PlanPersistence.js"
import type { Db, QueryResult } from "../shared/types/infrastructure.js"
import mysql from "mysql2/promise"

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
        // await this.phaseDeploy(input) // TODO: reativar quando deploy.sh estiver configurado
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
    const model = this.chainFor(input, "analysis")[0]!
    const sessionKey = formatSessionKey({ agentId: input.task.agentId, taskId: input.task.id, phase: "analysis", model: model.model, modelIndex: 0, generation: 0 })

    const session = await driver.createSession({
      agentId: input.task.agentId,
      key: sessionKey,
      label: "motor-v2-analyze-" + input.task.id,
      model: model.model,
    })

    const prompt = this.buildAnalystPrompt(input.task)
    this.log("info", "Enviando prompt para analista...")

    const { runId } = await driver.sendMessage({ session, message: prompt })
    this.log("info", "Analista respondendo... runId=" + runId)

    const result = await driver.waitForRunCompletion(session, runId, 1_800_000)

    if (result.state !== "final" || !result.content) {
      throw new Error("Analista falhou: " + (result.errorMessage || result.state))
    }

    const subtarefas = this.parseAnalystResponse(result.content)
    this.log("info", "Analista criou " + subtarefas.length + " subtarefas")

    const persisted = await persistPlan(planningDb, input.task.id, subtarefas)
    if (persisted === "already_persisted") {
      this.log("info", "Plano foi persistido por outra execução; preservando-o")
    }
    await driver.closeSession(session).catch(() => {})
    this.log("info", "Fase ANALYZE concluida: " + subtarefas.length + " subtarefas criadas")
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
          session = await driver.createSession({ agentId: input.task.agentId, key: sessionKey, label: `motor-v2-subtask-${subtask.id}`, model: model.model })
          const prompt = this.buildProgrammerPrompt(input.task, subtask, input.repoPath, lastFailure || undefined)
          const { runId } = await driver.sendMessage({ session, message: prompt })
          const result = await driver.waitForRunCompletion(session, runId, 1_800_000)
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
      if (isSystemicFailure(modelFailures)) {
        const reason = "Falha sistêmica repetida entre modelos: " + lastFailure
        await this.recordBlocker(subtask, "systemic_failure", reason)
        throw new Error(reason)
      }
      this.log("warn", `Escalando modelo após falha: ${model.model}`)
    }
    const reason = "Escada de modelos esgotada: " + (lastFailure || "subtarefa não aprovada")
    await this.recordBlocker(subtask, "model_chain_exhausted", reason)
    throw new Error(reason)
  }

  /**
   * FASE 4: VERIFY - npm run build + npm run test
   */
  private async phaseVerify(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "verify", message: "Verificando build e teste" })
    this.log("info", "Fase VERIFY: build + test")

    this.log("info", "Executando: " + input.buildCommand)
    try {
      this.exec(input.buildCommand, input.repoPath, 120_000)
      this.log("info", "Build OK")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error("Build falhou: " + msg.substring(0, 500), { cause: error })
    }

    this.log("info", "Executando: " + input.testCommand)
    try {
      this.exec(input.testCommand, input.repoPath, 120_000)
      this.log("info", "Testes OK")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error("Testes falharam: " + msg.substring(0, 500), { cause: error })
    }
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
   * FASE 5: DEPLOY - Checkout base, merge, push
   */
  private async phaseDeploy(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "deploy", message: "Deploy: merge e push" })
    this.log("info", "Fase DEPLOY")

    const repoPath = input.repoPath
    const workBranch = input.workBranch || "motor-v2/task-" + input.task.id
    const baseBranch = "base-desenvolvimento"

    const status = this.exec("git status --porcelain", repoPath)
    if (status.trim()) {
      this.exec("git add -A", repoPath)
      const commitMsg = "motor-v2: tarefa " + input.task.id
      this.exec('git commit -m "' + commitMsg + '"', repoPath)
    }

    this.exec("git checkout " + baseBranch, repoPath)
    this.exec("git merge " + workBranch + " --no-edit", repoPath)
    // this.exec("git push origin " + baseBranch, repoPath) // TODO: habilitar quando SSH key configurada

    this.log("info", "Deploy concluido: merge + push")
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
      "Regras: crie no maximo 4 subtarefas. Seja especifico no scope. Nao inclua explicacao fora do JSON.",
    ].join("\n")
  }

  private buildProgrammerPrompt(task: { title: string }, subtask: SubtaskInfo, repoPath: string, reworkNote?: string): string {
    return [
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

    const [claimed] = await this.db.query(
      "UPDATE projeto_640.subtarefas SET correction_created_at = NOW(), correction_fingerprint = ? WHERE id = ? AND correction_created_at IS NULL",
      [fingerprint, subtask.id],
    ) as unknown as [{ affectedRows: number }]
    if (claimed.affectedRows !== 1) return false
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq + 10000 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq])
    await this.db.query("UPDATE projeto_640.subtarefas SET seq = seq - 9999 WHERE tarefa_id = (SELECT tarefa_id FROM (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AS source) AND seq > ?", [subtask.id, subtask.seq + 10000])
    await this.db.query(
      "INSERT INTO projeto_640.subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_for_subtask_id, correction_fingerprint, created_at, updated_at) " +
      "SELECT tarefa_id, ?, ?, ?, acceptance_criteria, 'pending', id, ?, NOW(), NOW() FROM projeto_640.subtarefas WHERE id = ?",
      [subtask.seq + 1, "Correção: " + subtask.titulo, "Corrigir gate repetido: " + reason.slice(0, 1000), fingerprint, subtask.id],
    )
    this.log("warn", "Subtarefa de correção criada para falha repetida " + fingerprint)
    return true
  }

  private exec(command: string, cwd: string, timeoutMs = 30000): string {
    try {
      return execSync(command, { cwd, timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      const e = error as { stderr?: Buffer; message: string }
      throw new Error((e.stderr?.toString() || e.message).substring(0, 500), { cause: error })
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

const worker = new TaskWorker()
worker.start().catch((error) => {
  console.error("[TaskWorker] Fatal:", error)
  process.exit(1)
})

export { TaskWorker }
