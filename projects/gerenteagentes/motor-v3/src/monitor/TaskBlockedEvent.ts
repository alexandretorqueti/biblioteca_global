import { createQueueMessage, type QueueMessage } from '../queue/QueueMessage.js'

/**
 * Contrato do evento TASK_BLOCKED — aciona o Monitor-Resolvedor.
 *
 * Todo ponto que insere em `bloqueios` DEVE emitir este evento na mesma
 * transação (via outbox), para que o Monitor seja acionado automaticamente
 * sem depender de polling. Especificação:
 * gerenteagentes/docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md
 */
export const TASK_BLOCKED_EVENT_TYPE = 'TASK_BLOCKED'

export interface TaskBlockedPayload {
  /** block_reason gravado em `bloqueios` (ex: deploy_failed, analysis_failed). */
  blockReason: string
  /** Comando/origem que gerou o bloqueio (ex: motor-v3:deploy:<batchId>). */
  blockCommand?: string | null
  /** Evidência resumida (block_excerpt). */
  blockExcerpt?: string | null
  /** Subtarefa relacionada, quando o bloqueio for em nível de subtarefa. */
  subtaskId?: number | null
  /** Lote de deploy relacionado, quando aplicável. */
  batchId?: string | null
  /** id numérico da tarefa em `tarefas`, quando conhecido. */
  databaseTaskId?: number | null
  /** id numérico da linha em `bloqueios`, quando conhecido. */
  blockId?: number | null
  /** Presente quando o evento é reemissão de um resume de tarefa bloqueada (etapa 6). */
  resumeReason?: string
}

export interface TaskBlockedMessageInput {
  /** external_id (task-pX-NNN) ou id numérico como string. */
  taskId: string
  executionId: string
  payload: TaskBlockedPayload
  correlationId?: string
  causationId?: string
}

/** Fábrica da mensagem TASK_BLOCKED (serializável, idempotente por messageId). */
export function createTaskBlockedMessage(input: TaskBlockedMessageInput): QueueMessage {
  return createQueueMessage({
    type: TASK_BLOCKED_EVENT_TYPE,
    taskId: input.taskId,
    executionId: input.executionId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: { ...input.payload } as Record<string, unknown>,
  })
}

/**
 * Contrato do evento TASK_UNBLOCKED — fato canônico do desbloqueio.
 *
 * Emitido na MESMA transação que grava `resolved_at` em `bloqueios`.
 * Permite que o Motor reavalie a tarefa (retomada/deploy) sem depender de
 * ação manual — lição do incidente da tarefa 886 (2026-09-24).
 */
export const TASK_UNBLOCKED_EVENT_TYPE = 'TASK_UNBLOCKED'

export interface TaskUnblockedPayload {
  blockId: number
  blockReason: string
  databaseTaskId?: number | null
  /** Veredito do Monitor que motivou o desbloqueio, quando houver. */
  verdictStatus?: string | null
  verdictOrigin?: string | null
  /** Quem desbloqueou: 'monitor' (automático) ou 'usuario'/'motor' (outros fluxos). */
  resolvedBy?: string
}

export interface TaskUnblockedMessageInput {
  taskId: string
  executionId: string
  payload: TaskUnblockedPayload
  correlationId?: string
  causationId?: string
}

/** Fábrica da mensagem TASK_UNBLOCKED. */
export function createTaskUnblockedMessage(input: TaskUnblockedMessageInput): QueueMessage {
  return createQueueMessage({
    type: TASK_UNBLOCKED_EVENT_TYPE,
    taskId: input.taskId,
    executionId: input.executionId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: { ...input.payload } as Record<string, unknown>,
  })
}
