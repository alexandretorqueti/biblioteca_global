import { z } from "zod"

const commandOutputSchema = z.object({
  commandId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
})

const taskExecutionPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.status.changed"), payload: z.object({ previousStatus: z.string().optional(), status: z.string() }) }),
  z.object({ type: z.literal("task.command.started"), payload: z.object({ commandId: z.string(), command: z.array(z.string()), displayCommand: z.string(), cwd: z.string().optional(), at: z.string().datetime().optional() }) }),
  z.object({ type: z.literal("task.command.output"), payload: commandOutputSchema }),
  z.object({ type: z.literal("task.command.finished"), payload: z.object({ commandId: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), durationMs: z.number().nonnegative(), success: z.boolean() }) }),
  z.object({ type: z.literal("task.timeout"), payload: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("task.error"), payload: z.object({ message: z.string() }) }),
])

export const taskExecutionEventSchema = taskExecutionPayloadSchema
export type TaskExecutionEvent = z.infer<typeof taskExecutionEventSchema>

export const taskEventEnvelopeSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  source: z.string(),
  organizationId: z.string().optional(),
  projectId: z.number().int().positive(),
  taskId: z.number().int().positive(),
  subtaskId: z.number().int().positive().optional(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
})
export type TaskEventEnvelope = z.infer<typeof taskEventEnvelopeSchema>

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), channel: z.literal("task"), taskId: z.number().int().positive(), lastSequence: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("ping") }),
])
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>

export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribed"), taskId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("event"), event: taskEventEnvelopeSchema }),
  z.object({ type: z.literal("replay_unavailable"), taskId: z.number().int().positive(), currentSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>
