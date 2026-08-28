/**
 * WorkerLauncher - Gerenciador de workers usando child_process
 */

import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerInput } from '../shared/types/execution.js'
import type { WorkerToCoordinatorMessage } from './WorkerProtocol.js'

export type WorkerEvent = WorkerToCoordinatorMessage

export class WorkerLauncher extends EventEmitter {
  private workers = new Map<string, ChildProcess>()
  private workerScript: string

  constructor(workerScript?: string) {
    super()
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    this.workerScript = workerScript ?? join(__dirname, 'TaskWorker.js')
  }

  /**
   * Spawna um novo worker para executar uma tarefa
   */
  async spawn(input: WorkerInput): Promise<string> {
    const { executionId } = input.context

    if (this.workers.has(executionId)) {
      throw new Error(`Worker para execução ${executionId} já existe`)
    }

    const worker = fork(this.workerScript, [], {
      env: {
        ...process.env,
        EXECUTION_ID: executionId,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })

    this.workers.set(executionId, worker)

    // Captura stdout/stderr do worker para debug
    worker.stdout?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) console.log('[Worker ' + executionId + ' stdout]', text)
    })
    worker.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) console.error('[Worker ' + executionId + ' stderr]', text)
    })

    worker.on('message', (msg: unknown) => {
      this.handleWorkerMessage(executionId, msg)
    })

    worker.on('error', (error: Error) => {
      this.emit('worker_error', { executionId, error })
      this.cleanupWorker(executionId)
    })

    worker.on('exit', (code: number | null, signal: string | null) => {
      console.log('[WorkerLauncher] Worker ' + executionId + ' exited code=' + code + ' signal=' + signal)
      this.emit('worker_exit', { executionId, code, signal })
      this.cleanupWorker(executionId)
    })

    // Aguarda mensagem 'ready'
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker ${executionId} não ficou pronto em 30s`))
        this.killWorker(executionId)
      }, 30000)

      worker.once('message', (msg: unknown) => {
        if (this.isReadyMessage(msg)) {
          clearTimeout(timeout)
          worker.send({ type: 'start', input })
          resolve()
        } else {
          clearTimeout(timeout)
          reject(new Error(`Mensagem inesperada: ${JSON.stringify(msg)}`))
          this.killWorker(executionId)
        }
      })
    })

    return executionId
  }

  cancel(executionId: string, reason: string): void {
    const worker = this.workers.get(executionId)
    if (worker?.connected) {
      worker.send({ type: 'cancel', reason })
    }
  }

  shutdownAll(): void {
    for (const [, worker] of this.workers) {
      if (worker.connected) {
        worker.send({ type: 'shutdown' })
      }
    }
  }

  killWorker(executionId: string): void {
    const worker = this.workers.get(executionId)
    if (worker) {
      worker.kill('SIGKILL')
      this.cleanupWorker(executionId)
    }
  }

  getActiveCount(): number {
    return this.workers.size
  }

  getActiveExecutions(): string[] {
    return Array.from(this.workers.keys())
  }

  isActive(executionId: string): boolean {
    return this.workers.has(executionId)
  }

  private handleWorkerMessage(executionId: string, msg: unknown): void {
    if (!this.isWorkerMessage(msg)) {
      console.warn(`[WorkerLauncher] Mensagem inválida de ${executionId}:`, msg)
      return
    }
    this.emit(msg.type, msg)
    this.emit('message', msg)
  }

  private cleanupWorker(executionId: string): void {
    this.workers.delete(executionId)
  }

  private isReadyMessage(msg: unknown): msg is { type: 'ready' } {
    return typeof msg === 'object' && msg !== null && (msg as { type: string }).type === 'ready'
  }

  private isWorkerMessage(msg: unknown): msg is WorkerToCoordinatorMessage {
    return typeof msg === 'object' && msg !== null && 'type' in msg
  }
}
