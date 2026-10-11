import { z } from "zod"

const commandOutputSchema = z.object({
  commandId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
})

const taskExecutionPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.started"), payload: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("task.status.changed"), payload: z.object({ previousStatus: z.string().optional(), status: z.string() }) }),
  z.object({ type: z.literal("task.command.started"), payload: z.object({ commandId: z.string(), command: z.array(z.string()), displayCommand: z.string(), cwd: z.string().optional(), at: z.string().datetime().optional() }) }),
  z.object({ type: z.literal("task.command.output"), payload: commandOutputSchema }),
  z.object({ type: z.literal("task.command.finished"), payload: z.object({ commandId: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), durationMs: z.number().nonnegative(), success: z.boolean() }) }),
  z.object({ type: z.literal("task.timeout"), payload: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("task.error"), payload: z.object({ message: z.string() }) }),
])

/**
 * Catálogo de eventos consumidos pelo Mapa de Agentes. Eventos do motor sem
 * prefixo (started/progress/...) são mantidos para compatibilidade com o
 * LibraryRealtimeBroadcaster do motor.
 */
export const realtimeEventTypeSchema = z.enum([
  "task.created", "task.updated", "task.deleted", "task.status.changed", "task.counters.updated",
  "task.started", "task.error", "task.timeout", "task.command.started", "task.command.output", "task.command.finished",
  "task.activity.created", "task.chat.delivery.updated", "task.interaction.checkpoint_requested",
  "task.interaction.awaiting", "task.interaction.resumed",
  "subtask.created", "subtask.updated", "subtask.deleted", "subtask.status.changed",
  "activity.created", "activity.updated", "deploy.diagnostics.updated", "history.entry.created",
  "chat.message.created", "chat.message.updated",
  "started", "progress", "log", "heartbeat", "completed", "failed", "model_unavailable",
  "developer_branch_integrated", "deployed", "clarifying", "system_alert", "system_recovered",
])
export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>

const taskCountersSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative().optional(),
  running: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
})

const taskSummarySchema = z.object({
  taskId: z.number().int().positive(),
  title: z.string().optional(),
  status: z.string(),
  counters: taskCountersSchema.optional(),
  updatedAt: z.string().datetime().optional(),
})

export const agentMapSnapshotSchema = z.object({
  projectId: z.number().int().positive(),
  tasks: z.array(taskSummarySchema),
  counters: taskCountersSchema,
})
export type AgentMapSnapshot = z.infer<typeof agentMapSnapshotSchema>

export const taskDetailSnapshotSchema = z.object({
  projectId: z.number().int().positive(),
  taskId: z.number().int().positive(),
  task: z.record(z.string(), z.unknown()),
  subtasks: z.array(z.record(z.string(), z.unknown())),
  activities: z.array(z.record(z.string(), z.unknown())),
  diagnostics: z.array(z.record(z.string(), z.unknown())),
  history: z.array(z.record(z.string(), z.unknown())),
  chat: z.array(z.record(z.string(), z.unknown())),
})
export type TaskDetailSnapshot = z.infer<typeof taskDetailSnapshotSchema>

export const taskExecutionEventSchema = taskExecutionPayloadSchema
export type TaskExecutionEvent = z.infer<typeof taskExecutionEventSchema>

const taskEventEnvelopeBaseSchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
  source: z.string(),
  organizationId: z.string().optional(),
  projectId: z.number().int().positive(),
  taskId: z.number().int().positive(),
  sourceTaskId: z.string().optional(),
  sourceProjectSlug: z.string().optional(),
  subtaskId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  type: realtimeEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
})
export const realtimeIngressEventSchema = taskEventEnvelopeBaseSchema
export type RealtimeIngressEvent = z.infer<typeof realtimeIngressEventSchema>

export const taskEventEnvelopeSchema = taskEventEnvelopeBaseSchema.extend({
  sequence: z.number().int().positive(),
})
export type TaskEventEnvelope = z.infer<typeof taskEventEnvelopeSchema>

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    channel: z.union([z.literal("task"), z.literal("project-feed"), z.literal("map")]),
    taskId: z.number().int().positive().optional(),
    lastSequence: z.number().int().nonnegative().optional(),
  }).refine(
    (data) => data.channel === "task" ? data.taskId !== undefined : true,
    { message: "taskId é obrigatório para canal 'task'" }
  ),
  z.object({ type: z.literal("ping") }),
])
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>

export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribed"), taskId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("feed_subscribed"), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("map_subscribed"), projectId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("event"), event: taskEventEnvelopeSchema }),
  z.object({ type: z.literal("map_snapshot"), projectId: z.number().int().positive(), currentSequence: z.number().int().nonnegative(), snapshot: agentMapSnapshotSchema }),
  z.object({ type: z.literal("task_snapshot"), taskId: z.number().int().positive(), currentSequence: z.number().int().nonnegative(), snapshot: taskDetailSnapshotSchema }),
  z.object({ type: z.literal("replay_unavailable"), taskId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("feed_replay_unavailable"), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("map_replay_unavailable"), projectId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>

export const REALTIME_REPLAY_UNAVAILABLE_CODE = "replay_unavailable" as const
