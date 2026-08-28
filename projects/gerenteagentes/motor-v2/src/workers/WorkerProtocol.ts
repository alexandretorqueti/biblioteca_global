/**
 * WorkerProtocol - Protocolo de comunicação Coordinator ↔ Worker
 */

import type { WorkerInput, ExecutionPhase, ExecutionResult } from '../shared/types/execution.js'

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
