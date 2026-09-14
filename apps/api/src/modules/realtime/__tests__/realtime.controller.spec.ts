// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { RealtimeController } from "../realtime.controller"
import type { RealtimeService } from "../realtime.service"

function controller() {
  const realtime = {
    aceitarUmaVez: vi.fn().mockReturnValue(true),
    publicar: vi.fn().mockReturnValue({ eventId: "event-1", sequence: 3 }),
  } as unknown as RealtimeService
  return { controller: new RealtimeController(realtime), realtime }
}

const validEvent = {
  eventId: "event-1",
  occurredAt: "2026-09-14T12:00:00.000Z",
  source: "gerenteagentes-motor-v2",
  projectId: 7,
  taskId: 42,
  type: "task.status.changed",
  payload: { status: "running" },
}

describe("RealtimeController", () => {
  it("valida e publica evento com Idempotency-Key compatível", () => {
    const { controller: instance, realtime } = controller()

    const result = instance.aceitarEvento(validEvent, "event-1")

    expect(result).toEqual({ ok: true, duplicate: false, eventId: "event-1", sequence: 3 })
    expect(realtime.aceitarUmaVez).toHaveBeenCalledWith("event-1")
    expect(realtime.publicar).toHaveBeenCalledWith(validEvent)
  })

  it("retorna sucesso idempotente sem republicar duplicata", () => {
    const { controller: instance, realtime } = controller()
    vi.mocked(realtime.aceitarUmaVez).mockReturnValue(false)

    const result = instance.aceitarEvento(validEvent)

    expect(result).toEqual({ ok: true, duplicate: true, eventId: "event-1" })
    expect(realtime.publicar).not.toHaveBeenCalled()
  })

  it("rejeita payload inválido e Idempotency-Key divergente", () => {
    const { controller: instance } = controller()

    expect(() => instance.aceitarEvento({ ...validEvent, taskId: 0 })).toThrow(BadRequestException)
    expect(() => instance.aceitarEvento(validEvent, "event-2")).toThrow(BadRequestException)
  })
})
