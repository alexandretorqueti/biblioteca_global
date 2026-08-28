/**
 * TaskWorker - Script que roda em child_process isolado
 * 
 * Etapa 5: Executa o pipeline completo de uma tarefa
 * Recebe WorkerInput via IPC, executa todas as steps, reporta resultado
 */

import type { WorkerInput, WorkerOutput, ExecutionContext } from '../shared/types/execution.js'
import type { CoordinatorToWorkerMessage, WorkerToCoordinatorMessage } from './WorkerProtocol.js'

// Worker process entry point
class TaskWorker {
  private executionId: string
  private cancelled = false
  private heartbeatInterval: NodeJS.Timeout | null = null

  constructor() {
    this.executionId = process.env.EXECUTION_ID ?? 'unknown'
  }

  /**
   * Inicia o worker e aguarda comandos via IPC
   */
  async start(): Promise<void> {
    // Sinaliza que está pronto
    this.send({ type: 'ready', workerId: this.executionId })

    // Aguarda mensagens do coordinator
    process.on('message', async (msg: unknown) => {
      await this.handleMessage(msg as CoordinatorToWorkerMessage)
    })

    // Configura heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, 10000)

    // Handler de shutdown
    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())
  }

  /**
   * Handler de mensagens do coordinator
   */
  private async handleMessage(msg: CoordinatorToWorkerMessage): Promise<void> {
    switch (msg.type) {
      case 'start':
        await this.execute(msg.input)
        break

      case 'cancel':
        this.cancelled = true
        this.log('warn', `Cancelamento solicitado: ${msg.reason}`)
        break

      case 'shutdown':
        this.shutdown()
        break
    }
  }

  /**
   * Executa o pipeline completo da tarefa
   */
  private async execute(input: WorkerInput): Promise<void> {
    const context = input.context

    try {
      this.send({ type: 'started', executionId: context.executionId })

      // ========== FASE 1: PREPARAÇÃO ==========
      this.send({ type: 'progress', executionId: context.executionId, phase: 'prepare', message: 'Preparando workspace' })
      
      // TODO: Implementar workspace preparation (clone, checkout, etc)
      // Por enquanto, assume que workspace já existe
      this.log('info', `Workspace: ${input.repoPath}`)

      if (this.cancelled) {
        this.sendResult(context, { ok: false, reason: 'Cancelled during preparation' })
        return
      }

      // ========== FASE 2: ANÁLISE ==========
      this.send({ type: 'progress', executionId: context.executionId, phase: 'analyze', message: 'Analisando tarefa' })

      // TODO: Implementar análise com agente
      this.log('info', `Tarefa: ${input.taskTitle}`)

      if (this.cancelled) {
        this.sendResult(context, { ok: false, reason: 'Cancelled during analysis' })
        return
      }

      // ========== FASE 3: EXECUÇÃO ==========
      this.send({ type: 'progress', executionId: context.executionId, phase: 'execute', message: 'Executando subtarefas' })

      // TODO: Implementar execução de subtarefas
      // Por enquanto, simula sucesso
      await this.sleep(2000) // Simula trabalho

      if (this.cancelled) {
        this.sendResult(context, { ok: false, reason: 'Cancelled during execution' })
        return
      }

      // ========== FASE 4: VERIFICAÇÃO ==========
      this.send({ type: 'progress', executionId: context.executionId, phase: 'verify', message: 'Verificando resultados' })

      // TODO: Implementar gate de verificação
      // Por enquanto, simula aprovação
      await this.sleep(1000)

      if (this.cancelled) {
        this.sendResult(context, { ok: false, reason: 'Cancelled during verification' })
        return
      }

      // ========== FASE 5: ENTREGA ==========
      this.send({ type: 'progress', executionId: context.executionId, phase: 'deliver', message: 'Entregando resultados' })

      // TODO: Implementar entrega (commit, push, notificação)
      await this.sleep(500)

      // Sucesso!
      this.sendResult(context, { ok: true })

    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log('error', `Erro durante execução: ${reason}`)
      this.sendResult(context, { ok: false, reason })
    }
  }

  /**
   * Envia resultado final para o coordinator
   */
  private sendResult(context: ExecutionContext, result: WorkerOutput['result']): void {
    const output: WorkerOutput = {
      executionId: context.executionId,
      taskId: context.taskId,
      result,
    }

    if (result.ok) {
      this.send({ type: 'completed', executionId: context.executionId, result })
    } else {
      this.send({ type: 'failed', executionId: context.executionId, error: result.reason ?? 'Unknown error' })
    }

    // Para heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    // Worker pode sair após resultado
    setTimeout(() => process.exit(result.ok ? 0 : 1), 1000)
  }

  /**
   * Envia heartbeat com métricas
   */
  private sendHeartbeat(): void {
    const memUsage = process.memoryUsage()
    this.send({
      type: 'heartbeat',
      executionId: this.executionId,
      cpuUsage: process.cpuUsage().user / 1000, // ms
      memUsage: memUsage.heapUsed / 1024 / 1024, // MB
    })
  }

  /**
   * Envia log para o coordinator
   */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.send({
      type: 'log',
      executionId: this.executionId,
      level,
      message,
    })
  }

  /**
   * Envia mensagem para o coordinator via IPC
   */
  private send(msg: WorkerToCoordinatorMessage): void {
    if (process.send) {
      process.send(msg)
    }
  }

  /**
   * Shutdown gracioso
   */
  private shutdown(): void {
    this.log('info', 'Shutdown solicitado')
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    process.exit(0)
  }

  /**
   * Helper para sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// Entry point
if (require.main === module) {
  const worker = new TaskWorker()
  worker.start().catch((error) => {
    console.error('[TaskWorker] Fatal error:', error)
    process.exit(1)
  })
}

export { TaskWorker }
