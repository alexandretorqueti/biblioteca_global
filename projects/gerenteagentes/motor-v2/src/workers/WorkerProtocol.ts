/**
 * WorkerProtocol - Protocolo de comunicação Coordinator ↔ Worker
 */

import type { WorkerInput, ExecutionPhase, ExecutionResult } from '../shared/types/execution.js'
import type { RemoteSessionFailure } from '../runtime/ConsoleAgentRuntimeDriver.js'

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
  | { type: 'clarifying'; executionId: string; questionCount: number; summary?: string }
  | { type: 'interaction_awaiting'; executionId: string; phase: 'analysis' | 'development' | 'verification'; summary?: string }
  | { type: 'chat_delivery'; executionId: string; messageId: number; deliveryId: number; state: 'consumed' | 'failed'; error?: string }
  | { type: 'failed'; executionId: string; error: string; sessionFailure?: RemoteSessionFailure }
  | { type: 'heartbeat'; executionId: string; cpuUsage?: number; memUsage?: number }
  | { type: 'model_unavailable'; executionId: string; model: string; message: string }
  | { type: 'log'; executionId: string; level: 'info' | 'warn' | 'error'; message: string }
