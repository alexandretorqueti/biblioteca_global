/**
 * WorkerLauncher - Gerenciador de workers usando child_process
 * 
 * Etapa 5: Implementa workers como processos filhos isolados
 */

import { fork, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { WorkerInput } from '../shared/types/execution.js'
import type { WorkerToCoordinatorMessage } from './WorkerProtocol.js'

export type WorkerEvent = WorkerToCoordinatorMessage

export class WorkerLauncher extends EventEmitter {
  private workers = new Map<string, ChildProcess>()
  private workerScript: string

  constructor(workerScript?: string) {
    super()
    this.workerScript = workerScript ?? join(__dirname, 'TaskWorker.js')
  }

  /**
   * Spawna um novo worker para executar uma tarefa
   */
  spawn(input: WorkerInput): Promise<string> {
    return new Promise((resolve, reject) => {
      const { executionId } = input

      // Verifica se já existe worker para esta execução
      if (this.workers.has(executionId)) {
        reject(new Error(`Worker para execução ${executionId} já existe`))
        return
      }

      // Fork do processo filho
      const worker = fork(this.workerScript, [], {
        env: {
          ...process.env,
          EXECUTION_ID: executionId,
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })

      this.workers.set(executionId, worker)

      // Configura handlers de mensagens
      worker.on('message', (msg: unknown) => {
        this.handleWorkerMessage(executionId, msg)
      })

      worker.on('error', (error) => {
        this.emit('worker_error', { executionId, error })
        this.cleanupWorker(executionId)
      })

      worker.on('exit', (code, signal) => {
        this.emit('worker_exit', { executionId, code, signal })
        this.cleanupWorker(executionId)
      })

      // Aguarda mensagem 'ready' do worker
      const readyTimeout = setTimeout(() => {
        reject(new Error(`Worker ${executionId} não ficou pronto em 30 segundos`))
        this.killWorker(executionId)
      }, 30000)

      worker.once('message', (msg: unknown) => {
        if (this.isReadyMessage(msg)) {
          clearTimeout(readyTimeout)
          
          // Envia comando de início
          worker.send({ type: 'start', input })
          resolve(executionId)
        } else {
          clearTimeout(readyTimeout)
          reject(new Error(`Mensagem inesperada do worker: ${JSON.stringify(msg)}`))
          this.killWorker(executionId)
        }
      })
    })
  }

  /**
   * Envia mensagem de cancelamento para um worker
   */
  cancel(executionId: string, reason: string): void {
    const worker = this.workers.get(executionId)
    if (worker && worker.connected) {
      worker.send({ type: 'cancel', reason })
    }
  }

  /**
   * Envia mensagem de shutdown para todos os workers
   */
  shutdownAll(): void {
    for (const [executionId, worker] of this.workers.entries()) {
      if (worker.connected) {
        worker.send({ type: 'shutdown' })
      }
    }
  }

  /**
   * Mata um worker específico
   */
  killWorker(executionId: string): void {
    const worker = this.workers.get(executionId)
    if (worker) {
      worker.kill('SIGKILL')
      this.cleanupWorker(executionId)
    }
  }

  /**
   * Obtém número de workers ativos
   */
  getActiveCount(): number {
    return this.workers.size
  }

  /**
   * Lista IDs de execução ativos
   */
  getActiveExecutions(): string[] {
    return Array.from(this.workers.keys())
  }

  /**
   * Verifica se um worker está ativo
   */
  isActive(executionId: string): boolean {
    return this.workers.has(executionId)
  }

  /**
   * Handler de mensagens do worker
   */
  private handleWorkerMessage(executionId: string, msg: unknown): void {
    if (!this.isWorkerMessage(msg)) {
      console.warn(`[WorkerLauncher] Mensagem inválida do worker ${executionId}:`, msg)
      return
    }

    // Emite evento específico do tipo de mensagem
    this.emit(msg.type, msg)
    
    // Emite evento genérico
    this.emit('message', msg)
  }

  /**
   * Limpa worker do registro
   */
  private cleanupWorker(executionId: string): void {
    this.workers.delete(executionId)
  }

  /**
   * Type guard para mensagem ready
   */
  private isReadyMessage(msg: unknown): msg is { type: 'ready' } {
    return typeof msg === 'object' && msg !== null && (msg as { type: string }).type === 'ready'
  }

  /**
   * Type guard para mensagem do worker
   */
  private isWorkerMessage(msg: unknown): msg is WorkerToCoordinatorMessage {
    return typeof msg === 'object' && msg !== null && 'type' in msg
  }
}
