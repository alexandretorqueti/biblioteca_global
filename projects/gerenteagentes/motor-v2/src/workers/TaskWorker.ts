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

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import type { WorkerInput, ExecutionContext, ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from "./WorkerProtocol.js"
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

      if (ctx.phase === "analyze") {
        await this.phaseAnalyze(input)
      } else if (ctx.phase === "execute") {
        await this.phasePrepare(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        await this.phaseExecute(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        await this.phaseVerify(input)
        if (this.cancelled) { this.sendFailed(ctx, "Cancelled"); return }
        await this.phaseDeploy(input)
      }

      this.sendCompleted(ctx, { ok: true })
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

    const driver = this.createDriver()
    const sessionKey = "motor-v2-analyze-" + input.task.id + "-" + Date.now()

    const session = await driver.createSession({
      agentId: "analista-senior",
      key: sessionKey,
      label: "motor-v2-analyze-" + input.task.id,
    })

    const prompt = this.buildAnalystPrompt(input.task)
    this.log("info", "Enviando prompt para analista...")

    const { runId } = await driver.sendMessage({ session, message: prompt })
    this.log("info", "Analista respondendo... runId=" + runId)

    const result = await driver.waitForRunCompletion(session, runId, 300_000)

    if (result.state !== "final" || !result.content) {
      throw new Error("Analista falhou: " + (result.errorMessage || result.state))
    }

    const subtarefas = this.parseAnalystResponse(result.content)
    this.log("info", "Analista criou " + subtarefas.length + " subtarefas")

    await this.saveSubtasks(input.task, subtarefas)
    await driver.closeSession(session).catch(() => {})
    this.log("info", "Fase ANALYZE concluida: " + subtarefas.length + " subtarefas criadas")
  }

  /**
   * FASE 2: PREPARE - Confere branch base, cria branch de trabalho, checkout
   */
  private async phasePrepare(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "prepare", message: "Preparando workspace" })
    this.log("info", "Fase PREPARE: " + input.repoPath)

    const repoPath = input.repoPath
    if (!existsSync(repoPath)) {
      throw new Error("Repositorio nao encontrado: " + repoPath)
    }

    const workBranch = input.workBranch || "motor-v2/task-" + input.task.id
    const baseBranch = "base-desenvolvimento"

    this.exec("git status --porcelain", repoPath)
    this.exec("git checkout " + baseBranch, repoPath)
    this.exec("git pull origin " + baseBranch, repoPath)

    try {
      this.exec("git checkout -b " + workBranch, repoPath)
    } catch {
      this.exec("git checkout " + workBranch, repoPath)
      this.exec("git merge " + baseBranch + " --no-edit", repoPath)
    }

    this.log("info", "Workspace preparado: branch " + workBranch)
  }

  /**
   * FASE 3: EXECUTE - Chama o Programador com a subtarefa
   */
  private async phaseExecute(input: WorkerInput): Promise<void> {
    this.send({ type: "progress", executionId: input.context.executionId, phase: "execute", message: "Executando subtarefa" })

    const subtask = input.subtask
    if (!subtask) {
      throw new Error("Subtarefa nao fornecida na fase execute")
    }

    this.log("info", "Fase EXECUTE: " + subtask.titulo)

    const driver = this.createDriver()
    const sessionKey = "motor-v2-exec-" + subtask.id + "-" + Date.now()

    const session = await driver.createSession({
      agentId: input.task.projectSlug || "biblioteca-global",
      key: sessionKey,
      label: "motor-v2-subtask-" + subtask.id,
    })

    const prompt = this.buildProgrammerPrompt(input.task, subtask, input.repoPath)
    this.log("info", "Enviando prompt para programador...")

    const { runId } = await driver.sendMessage({ session, message: prompt })
    this.log("info", "Programador respondendo... runId=" + runId)

    const result = await driver.waitForRunCompletion(session, runId, 600_000)

    if (result.state !== "final") {
      await driver.closeSession(session).catch(() => {})
      throw new Error("Programador falhou: " + (result.errorMessage || result.state))
    }

    this.log("info", "Programador concluiu: " + subtask.titulo)

    await this.db!.query(
      "UPDATE projeto_640.subtarefas SET status = 'verified', resultado = ?, finalizada_em = NOW() WHERE id = ?",
      [result.content?.substring(0, 500) || "OK", subtask.id]
    )

    await driver.closeSession(session).catch(() => {})
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
      throw new Error("Build falhou: " + msg.substring(0, 500))
    }

    this.log("info", "Executando: " + input.testCommand)
    try {
      this.exec(input.testCommand, input.repoPath, 120_000)
      this.log("info", "Testes OK")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error("Testes falharam: " + msg.substring(0, 500))
    }
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
    this.exec("git push origin " + baseBranch, repoPath)

    this.log("info", "Deploy concluido: merge + push")
  }

  // === HELPERS ===

  private createDriver(): ConsoleAgentRuntimeDriver {
    const baseUrl = process.env.OPENCLAW_CONSOLE_URL
    const token = process.env.OPENCLAW_CONSOLE_TOKEN
    if (!baseUrl || !token) throw new Error("OPENCLAW_CONSOLE_URL e OPENCLAW_CONSOLE_TOKEN sao obrigatorios")
    return new ConsoleAgentRuntimeDriver({ baseUrl, token })
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

  private buildProgrammerPrompt(task: { title: string }, subtask: SubtaskInfo, repoPath: string): string {
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
      "3. Responda com um resumo do que foi feito",
    ].join("\n")
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

  private async saveSubtasks(task: { id: string }, subtarefas: Array<{ seq: number; titulo: string; scope?: string; acceptanceCriteria?: string[] }>): Promise<void> {
    if (!this.db) throw new Error("DB not connected")

    const isNumeric = /^\d+$/.test(task.id)
    const [rows] = await this.db.query(
      isNumeric
        ? "SELECT id FROM projeto_640.tarefas WHERE external_id = ? OR id = ?"
        : "SELECT id FROM projeto_640.tarefas WHERE external_id = ?",
      isNumeric ? [task.id, task.id] : [task.id]
    )

    const taskId = (rows as Array<Record<string, unknown>>)[0]?.id as number
    if (!taskId) throw new Error("Tarefa nao encontrada: " + task.id)

    await this.db.query("DELETE FROM projeto_640.subtarefas WHERE tarefa_id = ?", [taskId])

    for (const st of subtarefas) {
      await this.db.query(
        "INSERT INTO projeto_640.subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())",
        [taskId, st.seq, st.titulo, st.scope || null, st.acceptanceCriteria ? JSON.stringify(st.acceptanceCriteria) : null]
      )
    }
  }

  private exec(command: string, cwd: string, timeoutMs = 30000): string {
    try {
      return execSync(command, { cwd, timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      const e = error as { stderr?: Buffer; message: string }
      throw new Error((e.stderr?.toString() || e.message).substring(0, 500))
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
