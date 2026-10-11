import { describe, expect, it } from "vitest"
import {
  agentMapSnapshotSchema,
  realtimeIngressEventSchema,
  realtimeServerMessageSchema,
  realtimeClientMessageSchema,
  taskDetailSnapshotSchema,
} from "../realtime"

const envelope = {
  eventId: "evt-1",
  occurredAt: "2026-09-30T10:00:00.000Z",
  source: "motor-v3",
  projectId: 7,
  taskId: 42,
  type: "task.counters.updated",
  payload: { counters: { total: 2, running: 1 } },
}

describe("contrato realtime do Mapa de Agentes", () => {
  it("aceita evento e snapshot de mapa válidos", () => {
    expect(realtimeIngressEventSchema.safeParse(envelope).success).toBe(true)
    expect(agentMapSnapshotSchema.safeParse({
      projectId: 7,
      tasks: [{ taskId: 42, status: "running" }],
      counters: { total: 1 },
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "map_snapshot", projectId: 7, currentSequence: 4,
      snapshot: { projectId: 7, tasks: [], counters: { total: 0 } },
    }).success).toBe(true)
  })

  it("rejeita envelope inválido e evento desconhecido com segurança", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, projectId: 0 }).success).toBe(false)
    expect(realtimeServerMessageSchema.safeParse({
      type: "event", event: { ...envelope, type: "future.event", sequence: 1 },
    }).success).toBe(false)
  })

  it("aceita payload válido com todos os campos obrigatórios", () => {
    const validEnvelope = {
      eventId: "evt-123",
      occurredAt: "2026-09-30T10:00:00.000Z",
      source: "motor-v3",
      projectId: 7,
      taskId: 42,
      type: "task.created",
      payload: { title: "Nova tarefa" },
    }
    expect(realtimeIngressEventSchema.safeParse(validEnvelope).success).toBe(true)
  })

  it("rejeita payload com projectId inválido (zero ou negativo)", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, projectId: 0 }).success).toBe(false)
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, projectId: -1 }).success).toBe(false)
  })

  it("rejeita payload com taskId inválido (zero ou negativo)", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, taskId: 0 }).success).toBe(false)
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, taskId: -5 }).success).toBe(false)
  })

  it("rejeita payload com eventId ausente ou vazio", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, eventId: "" }).success).toBe(false)
    const { eventId, ...withoutEventId } = envelope
    expect(realtimeIngressEventSchema.safeParse(withoutEventId).success).toBe(false)
  })

  it("rejeita payload com occurredAt inválido", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, occurredAt: "not-a-date" }).success).toBe(false)
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, occurredAt: "" }).success).toBe(false)
  })

  it("aceita todos os tipos de evento do catálogo", () => {
    const eventTypes = [
      "task.created", "task.updated", "task.deleted", "task.status.changed", "task.counters.updated",
      "subtask.created", "subtask.updated", "subtask.deleted", "subtask.status.changed",
      "activity.created", "activity.updated", "deploy.diagnostics.updated", "history.entry.created",
      "chat.message.created", "chat.message.updated",
    ]
    for (const type of eventTypes) {
      const result = realtimeIngressEventSchema.safeParse({ ...envelope, type })
      expect(result.success).toBe(true)
    }
  })

  it("rejeita evento desconhecido (fora do catálogo)", () => {
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, type: "unknown.event" }).success).toBe(false)
    expect(realtimeIngressEventSchema.safeParse({ ...envelope, type: "future.feature" }).success).toBe(false)
  })

  it("aceita snapshot de detalhe de tarefa válido", () => {
    const snapshot = {
      projectId: 7,
      taskId: 42,
      task: { id: 42, title: "Tarefa teste", status: "running" },
      subtasks: [{ id: 1, title: "Subtarefa 1", status: "completed" }],
      activities: [{ id: 1, type: "execution", message: "Executando" }],
      diagnostics: [{ canStart: true, reasons: [] }],
      history: [{ id: 1, event: "task.started", occurredAt: "2026-09-30T10:00:00Z" }],
      chat: [{ id: 1, role: "user", text: "Olá", createdAt: "2026-09-30T10:00:00Z" }],
    }
    expect(taskDetailSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it("aceita mensagens de cliente para todos os canais", () => {
    expect(realtimeClientMessageSchema.safeParse({
      type: "subscribe", channel: "task", taskId: 42, lastSequence: 5,
    }).success).toBe(true)
    expect(realtimeClientMessageSchema.safeParse({
      type: "subscribe", channel: "project-feed", lastSequence: 10,
    }).success).toBe(true)
    expect(realtimeClientMessageSchema.safeParse({
      type: "subscribe", channel: "map", lastSequence: 3,
    }).success).toBe(true)
    expect(realtimeClientMessageSchema.safeParse({ type: "ping" }).success).toBe(true)
  })

  it("rejeita mensagem de cliente com canal inválido", () => {
    expect(realtimeClientMessageSchema.safeParse({
      type: "subscribe", channel: "invalid-channel",
    }).success).toBe(false)
  })

  it("rejeita mensagem de cliente task sem taskId", () => {
    expect(realtimeClientMessageSchema.safeParse({
      type: "subscribe", channel: "task",
    }).success).toBe(false)
  })

  it("aceita mensagens de servidor para todos os tipos", () => {
    expect(realtimeServerMessageSchema.safeParse({
      type: "subscribed", taskId: 42, currentSequence: 5,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "feed_subscribed", currentSequence: 10,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "map_subscribed", projectId: 7, currentSequence: 3,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "event", event: { ...envelope, sequence: 1 },
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "map_snapshot", projectId: 7, currentSequence: 4,
      snapshot: { projectId: 7, tasks: [], counters: { total: 0 } },
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "task_snapshot", taskId: 42, currentSequence: 2,
      snapshot: { projectId: 7, taskId: 42, task: {}, subtasks: [], activities: [], diagnostics: [], history: [], chat: [] },
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "replay_unavailable", taskId: 42, currentSequence: 5,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "feed_replay_unavailable", currentSequence: 10,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "map_replay_unavailable", projectId: 7, currentSequence: 3,
    }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({ type: "pong" }).success).toBe(true)
    expect(realtimeServerMessageSchema.safeParse({
      type: "error", code: "INVALID_SUBSCRIPTION", message: "Inscrição inválida",
    }).success).toBe(true)
  })
})
