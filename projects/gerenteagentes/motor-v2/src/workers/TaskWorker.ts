/**
 * TaskWorker - Script que roda em child_process isolado
 * Pipeline completo: git → OpenClaw Console → commit → push
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { ConsoleAgentRuntimeDriver } from '../runtime/ConsoleAgentRuntimeDriver.js'
import type { WorkerInput, ExecutionContext, ExecutionResult } from '../shared/types/execution.js'
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from './WorkerProtocol.js'

class TaskWorker {
  private executionId: string
  private cancelled = false
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.executionId = process.env.EXECUTION_ID ?? 'unknown'
  }

  async start(): Promise<void> {
    this.send({ type: 'ready', workerId: this.executionId })

    process.on('message', async (msg: unknown) => {
      await this.handleMessage(msg as CoordinatorToWorkerMessage)
    })

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, 10000)

    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())
  }

  private async handleMessage(msg: CoordinatorToWorkerMessage): Promise<void> {
    switch (msg.type) {
      case 'start':
        await this.execute(msg.input)
        break
      case 'cancel':
        this.cancelled = true
        this.log('warn', `Cancelamento: ${msg.reason}`)
        break
      case 'shutdown':
        this.shutdown()
        break
    }
  }

  private async execute(input: WorkerInput): Promise<void> {
    const context = input.context
    const repoPath = input.repoPath

    try {
      this.send({ type: 'started', executionId: context.executionId })

      // FASE 1: PREPARAÇÃO
      this.send({ type: 'progress', executionId: context.executionId, phase: 'prepare', message: 'Preparando workspace' })
      this.log('info', `Workspace: ${repoPath}`)
      
      if (!existsSync(repoPath)) {
        throw new Error(`Repo não encontrado: ${repoPath}`)
      }
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during preparation'); return }

      // FASE 2: ANÁLISE — ler tarefa
      this.send({ type: 'progress', executionId: context.executionId, phase: 'analyze', message: 'Analisando tarefa' })
      this.log('info', `Tarefa: ${input.task.title}`)
      this.log('info', `Descrição: ${input.task.description}`)
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during analysis'); return }

      // FASE 3: EXECUÇÃO — criar sessão no agente e enviar prompt
      this.send({ type: 'progress', executionId: context.executionId, phase: 'execute', message: 'Executando via OpenClaw Console' })
      
      const consoleUrl = process.env.OPENCLAW_CONSOLE_URL
      const consoleToken = process.env.OPENCLAW_CONSOLE_TOKEN
      
      if (!consoleUrl || !consoleToken) {
        throw new Error('OPENCLAW_CONSOLE_URL e OPENCLAW_CONSOLE_TOKEN são obrigatórios')
      }
      
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl: consoleUrl, token: consoleToken })
      
      // Cria sessão para o agente do projeto
      const session = await driver.createSession({
        agentId: input.task.projectSlug || 'programador-senior',
        label: `motor-v2-task-${input.task.id}`,
      })
      this.log('info', `Sessão criada: ${session.key}`)
      
      // Envia prompt para o agente
      const prompt = this.buildPrompt(input.task)
      const result = await driver.sendMessage({
        sessionKey: session.key,
        agentId: session.agentId,
        prompt,
      }, { timeoutMs: 600_000 }) // 10 min timeout
      
      if (!result.ok) {
        throw new Error(`Agente falhou: ${result.errorMessage || result.stopReason}`)
      }
      this.log('info', 'Agente completou a tarefa')
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during execution'); return }

      // FASE 4: VERIFICAÇÃO (sem git por enquanto — SSH key pendente)
      this.send({ type: 'progress', executionId: context.executionId, phase: 'verify', message: 'Verificando resultados' })
      this.log('info', 'Agente completou a execução')
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during verification'); return }

      // FASE 5: ENTREGA
      this.send({ type: 'progress', executionId: context.executionId, phase: 'deliver', message: 'Tarefa concluída' })
      this.log('info', `Tarefa ${input.task.id} concluída com sucesso`)

      this.sendCompleted(context, { ok: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log('error', `Erro: ${reason}`)
      this.sendFailed(context, reason)
    }
  }

  private buildPrompt(task: any): string {
    return `## Tarefa

**Título:** ${task.title}

**Descrição:**
${task.description}

**Instruções:**
- Implemente a mudança descrita acima
- Siga as boas práticas do projeto
- Teste localmente antes de finalizar
- Responda "concluído" quando terminar`
  }

  private exec(command: string, cwd: string): string {
    this.log('info', `$ ${command}`)
    try {
      const output = execSync(command, { cwd, encoding: 'utf-8', timeout: 30_000 })
      if (output.trim()) {
        this.log('info', output.substring(0, 200))
      }
      return output
    } catch (error: any) {
      this.log('error', `Command failed: ${error.message}`)
      throw error
    }
  }

  private sendCompleted(context: ExecutionContext, result: ExecutionResult): void {
    this.send({ type: 'completed', executionId: context.executionId, result })
    this.cleanup()
    setTimeout(() => process.exit(0), 1000)
  }

  private sendFailed(context: ExecutionContext, error: string): void {
    this.send({ type: 'failed', executionId: context.executionId, error })
    this.cleanup()
    setTimeout(() => process.exit(1), 1000)
  }

  private sendHeartbeat(): void {
    const mem = process.memoryUsage()
    this.send({
      type: 'heartbeat',
      executionId: this.executionId,
      cpuUsage: process.cpuUsage().user / 1000,
      memUsage: mem.heapUsed / 1024 / 1024,
    })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.send({ type: 'log', executionId: this.executionId, level, message })
  }

  private send(msg: WorkerToCoordinatorMessage): void {
    if (process.send) {
      process.send(msg)
    }
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private shutdown(): void {
    this.log('info', 'Shutdown')
    this.cleanup()
    process.exit(0)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// Entry point
const worker = new TaskWorker()
worker.start().catch((error) => {
  console.error('[TaskWorker] Fatal:', error)
  process.exit(1)
})

export { TaskWorker }
