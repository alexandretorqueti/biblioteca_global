/**
 * TaskWorker - Script que roda em child_process isolado
 */

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

    try {
      this.send({ type: 'started', executionId: context.executionId })

      // FASE 1: PREPARAÇÃO
      this.send({ type: 'progress', executionId: context.executionId, phase: 'prepare', message: 'Preparando workspace' })
      this.log('info', `Workspace: ${input.repoPath}`)
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during preparation'); return }

      // FASE 2: ANÁLISE
      this.send({ type: 'progress', executionId: context.executionId, phase: 'analyze', message: 'Analisando tarefa' })
      this.log('info', `Tarefa: ${input.task.title}`)
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during analysis'); return }

      // FASE 3: EXECUÇÃO - criar arquivo de teste em /tmp
      this.send({ type: 'progress', executionId: context.executionId, phase: 'execute', message: 'Executando mudança' })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const testFile = `motor-v2-test-${timestamp}.txt`
      const testPath = `/tmp/${testFile}`
      await this.writeFile(testPath, `Teste do motor-v2\nTarefa: ${input.task.id}\nTimestamp: ${timestamp}\nRepo: ${input.repoPath}\n`)
      this.log('info', `Arquivo criado: ${testPath}`)
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during execution'); return }

      // FASE 4: VERIFICAÇÃO
      this.send({ type: 'progress', executionId: context.executionId, phase: 'verify', message: 'Verificando resultados' })
      const content = await this.readFile(testPath)
      this.log('info', `Arquivo verificado: ${content.length} bytes`)
      if (this.cancelled) { this.sendFailed(context, 'Cancelled during verification'); return }

      // FASE 5: ENTREGA
      this.send({ type: 'progress', executionId: context.executionId, phase: 'deliver', message: 'Entregando resultados' })
      this.log('info', `Tarefa ${input.task.id} concluída com sucesso`)


      this.sendCompleted(context, { ok: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log('error', `Erro: ${reason}`)
      this.sendFailed(context, reason)
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const { writeFileSync } = await import('fs')
    writeFileSync(path, content)
  }

  private async readFile(path: string): Promise<string> {
    const { readFileSync } = await import('fs')
    return readFileSync(path, 'utf-8')
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
