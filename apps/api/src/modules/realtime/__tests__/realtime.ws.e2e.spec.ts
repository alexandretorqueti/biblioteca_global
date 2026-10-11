// @vitest-environment node
import { WsAdapter } from "@nestjs/platform-ws"
import { JwtService } from "@nestjs/jwt"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import type { WebSocket as WsClient } from "ws"
import { WebSocket } from "ws"
import { RealtimeGateway } from "../realtime.gateway"
import { RealtimeService } from "../realtime.service"
import { AUTH_REPOSITORY } from "../../auth/auth.repository"

const PROJECT_ID = 7
const TASK_ID = 832

type WireMessage = Record<string, unknown> & {
  type?: string
  event?: Record<string, unknown>
}

function waitForMessage(socket: WsClient, predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage)
      reject(new Error("Tempo esgotado aguardando mensagem realtime"))
    }, 2_000)
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as WireMessage
      if (!predicate(message)) return
      clearTimeout(timeout)
      socket.off("message", onMessage)
      resolve(message)
    }
    socket.on("message", onMessage)
  })
}

function collectMessages(socket: WsClient, count: number, predicate: (message: WireMessage) => boolean): Promise<WireMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WireMessage[] = []
    const timeout = setTimeout(() => {
      socket.off("message", onMessage)
      reject(new Error(`Tempo esgotado aguardando ${count} mensagens realtime`))
    }, 2_000)
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as WireMessage
      if (!predicate(message)) return
      messages.push(message)
      if (messages.length !== count) return
      clearTimeout(timeout)
      socket.off("message", onMessage)
      resolve(messages)
    }
    socket.on("message", onMessage)
  })
}

function subscribeMap(socket: WsClient, lastSequence?: number): void {
  socket.send(JSON.stringify({
    event: "subscribe",
    data: { type: "subscribe", channel: "map", ...(lastSequence === undefined ? {} : { lastSequence }) },
  }))
}

function publish(realtime: RealtimeService, eventId: string, sequence: { previousStatus: string; status: string }, payload: Record<string, unknown> = {}): void {
  realtime.publicar({
    eventId,
    occurredAt: "2026-10-11T10:00:00.000Z",
    source: "e2e-boundary",
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    type: "task.status.changed",
    payload: { ...sequence, ...payload },
  })
}

describe("Realtime E2E — WsAdapter real / canal map", () => {
  let app: INestApplication
  let realtime: RealtimeService
  let address: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        RealtimeService,
        RealtimeGateway,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              if (token !== "ticket-projeto-7") throw new Error("ticket inválido")
              return { sub: 42, projetoId: PROJECT_ID, kind: "ws-ticket" }
            },
          },
        },
        {
          provide: AUTH_REPOSITORY,
          useValue: { resolveScope: async (_userId: number, projectId: number) => projectId === PROJECT_ID ? { projectId } : null },
        },
      ],
    }).compile()

    app = module.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    realtime = app.get(RealtimeService)
    app.get(RealtimeGateway).setMapSnapshotProvider(async (projectId) => ({
      projectId,
      tasks: [{ taskId: TASK_ID, title: "Tarefa em rascunho", status: "draft", counters: { total: 3, pending: 3 } }],
      counters: { total: 1 },
    }))
    await app.listen(0, "127.0.0.1")
    const server = app.getHttpServer() as { address: () => { port: number } }
    address = `ws://127.0.0.1:${server.address().port}/api/realtime/ws?ticket=ticket-projeto-7`
  })

  afterAll(async () => {
    await app.close()
  })

  it("regressão da 832: iniciarTarefa sem emissor manual deixa de silenciar o canal map", async () => {
    const socket = new WebSocket(address)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    subscribeMap(socket)
    await waitForMessage(socket, (message) => message.type === "map_subscribed")

    // A entrada representa o commit feito pela fronteira canônica após
    // remover paused_at; o controller não chama realtime.publicar.
    publish(realtime, "task-832-planned", { previousStatus: "draft", status: "planned" })
    const message = await waitForMessage(socket, (item) => item.type === "event")
    expect(message.event).toMatchObject({
      eventId: "task-832-planned",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      type: "task.status.changed",
      sequence: 1,
      payload: { previousStatus: "draft", status: "planned" },
    })
    socket.close()
  })

  it("entrega iniciar, claim, pausa/retomada e subtarefa em ordem canônica", async () => {
    const socket = new WebSocket(address)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    subscribeMap(socket)
    const subscribed = await waitForMessage(socket, (message) => message.type === "map_subscribed")
    const initialSequence = Number(subscribed.currentSequence)

    const eventsPromise = collectMessages(socket, 6, (message) => message.type === "event")
    publish(realtime, "task-planned", { previousStatus: "draft", status: "planned" })
    publish(realtime, "task-analyzing", { previousStatus: "planned", status: "analyzing" }, { claimConfirmed: true })
    publish(realtime, "task-paused", { previousStatus: "analyzing", status: "paused" })
    publish(realtime, "task-resumed", { previousStatus: "paused", status: "planned" })
    realtime.publicar({ eventId: "subtask-pending", occurredAt: "2026-10-11T10:00:00.000Z", source: "e2e-boundary", projectId: PROJECT_ID, taskId: TASK_ID, subtaskId: 1, type: "subtask.status.changed", payload: { previousStatus: "pending", status: "running", counters: { total: 3, pending: 2, running: 1, completed: 0 } } })
    realtime.publicar({ eventId: "subtask-verified", occurredAt: "2026-10-11T10:00:00.000Z", source: "e2e-boundary", projectId: PROJECT_ID, taskId: TASK_ID, subtaskId: 1, type: "subtask.status.changed", payload: { previousStatus: "running", status: "verified", counters: { total: 3, pending: 2, running: 0, completed: 1 } } })

    const events = await eventsPromise
    expect(events.map((message) => (message.event?.payload as Record<string, unknown>)?.status)).toEqual(["planned", "analyzing", "paused", "planned", "running", "verified"])
    expect(events.map((message) => message.event?.sequence)).toEqual([1, 2, 3, 4, 5, 6].map((offset) => initialSequence + offset))
    expect(events[1]?.event?.payload).toMatchObject({ previousStatus: "planned", status: "analyzing", claimConfirmed: true })
    expect(events[4]?.event?.payload).toMatchObject({ counters: { total: 3, pending: 2, running: 1, completed: 0 } })
    expect(events[5]?.event?.payload).toMatchObject({ counters: { total: 3, pending: 2, running: 0, completed: 1 } })
    expect(events.every((message) => (message.event?.payload as Record<string, unknown>)?.status !== "resumed")).toBe(true)
    socket.close()
  })

  it("reconecta com lastSequence, faz replay incremental e deduplica reenvio", async () => {
    const first = new WebSocket(address)
    await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject) })
    subscribeMap(first)
    const subscribed = await waitForMessage(first, (message) => message.type === "map_subscribed")
    const initialSequence = Number(subscribed.currentSequence)
    const firstEventPromise = waitForMessage(first, (message) => message.type === "event")
    publish(realtime, "replay-1", { previousStatus: "draft", status: "planned" })
    const firstEvent = await firstEventPromise
    expect(firstEvent.event?.sequence).toBe(initialSequence + 1)
    first.close()

    publish(realtime, "replay-2", { previousStatus: "planned", status: "analyzing" })
    // Reenvio simulado pelo dispatcher após falha transitória do ingresso.
    publish(realtime, "replay-2", { previousStatus: "planned", status: "analyzing" })

    const second = new WebSocket(address)
    await new Promise<void>((resolve, reject) => { second.once("open", resolve); second.once("error", reject) })
    const replayPromise = waitForMessage(second, (message) => message.type === "event")
    subscribeMap(second, initialSequence + 1)
    await waitForMessage(second, (message) => message.type === "map_snapshot")
    const replay = await replayPromise
    expect(replay.event).toMatchObject({ eventId: "replay-2", sequence: initialSequence + 2, payload: { previousStatus: "planned", status: "analyzing" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const replayEvents = await new Promise<WireMessage[]>((resolve) => {
      const messages: WireMessage[] = []
      const listener = (raw: Buffer) => { const message = JSON.parse(raw.toString()) as WireMessage; if (message.type === "event") messages.push(message) }
      second.on("message", listener)
      setTimeout(() => { second.off("message", listener); resolve(messages) }, 50)
    })
    expect(replayEvents).toHaveLength(0)
    second.close()
  })

  it("preserva escopo por projeto no ticket WS", async () => {
    const socket = new WebSocket(`${address.replace("ticket-projeto-7", "ticket-projeto-8")}`)
    const code = await new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)))
    expect(code).toBe(1008)
  })
})
