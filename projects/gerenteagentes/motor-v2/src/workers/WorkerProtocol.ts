/**
 * WorkerProtocol - Protocolo de comunicação entre Coordenador e Worker
 * 
 * Mensagens Coordinator → Worker e Worker → Coordinator
 */

import type { ExecutionContext, ExecutionPhase, WorkerInput, ExecutionResult } from '../shared/types/execution.js'

// Coordinator → Worker
export type CoordinatorToWorkerMessage =
  | { type: 'start'; input: WorkerInput }
  | { type: 'cancel'; reason: string }
  | { type: 'shutdown' }

// Worker → Coordinator
export type WorkerToCoordinatorMessage =
  | { type: 'ready'; workerId: string }
  | { type: 'started'; executionId: string }
  | { type: 'progress'; executionId: string; phase: ExecutionPhase; message: string }
  | { type: 'waiting_resource'; executionId: string; resourceKey: string; waitId: number; position: number }
  | { type: 'completed'; executionId: string; result: ExecutionResult }
  | { type: 'failed'; executionId: string; error: string }
  | { type: 'heartbeat'; executionId: string; cpuUsage?: number; memUsage?: number }
  | { type: 'log'; executionId: string; level: 'info' | 'warn' | 'error'; message: string }

export function isCoordinatorMessage(msg: unknown): msg is CoordinatorToWorkerMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && 
    ['start', 'cancel', 'shutdown'].includes(String((msg as Record<string, unknown>).type))
}

export function isWorkerMessage(msg: unknown): msg is WorkerToCoordinatorMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg &&
    ['ready', 'started', 'progress', 'waiting_resource', 'completed', 'failed', 'heartbeat', 'log'].includes(String((msg as Record<string, unknown>).type))
}
