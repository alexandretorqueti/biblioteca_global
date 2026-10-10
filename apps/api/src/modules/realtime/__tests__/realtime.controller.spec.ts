// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { RealtimeController } from "../realtime.controller"
import { RealtimeService } from "../realtime.service"

const validEvent = {
  eventId: "evt-unique-001",
  occurredAt: "2026-10-09T12:00:00.000Z",
  source: "test",
  projectId: 7,
  taskId: 42,
  type: "task.updated" as const,
  payload: { title: "Correção dedup" },
}

describe("RealtimeController — aceitarEvento", () => {
  let controller: RealtimeController
  let service: RealtimeService

  beforeEach(() => {
    service = new RealtimeService()
    controller = new RealtimeController(service)
  })

  it("primeiro POST de evento válido retorna ok:true, duplicate:false com sequence>0", () => {
    const result = controller.aceitarEvento(validEvent)
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      eventId: "evt-unique-001",
      sequence: 1,
    })
  })

  it("segundo POST com o mesmo eventId retorna 2xx sem 500 (publicar idempotente via envelopesPorId)", () => {
    controller.aceitarEvento(validEvent)
    // publicar() encontra o envelope em envelopesPorId e retorna sem lançar.
    // O controller mapeia para duplicate:false pois não houve throw — o dedup
    // é transparente via idempotência de publicar(). Sem 500.
    const result = controller.aceitarEvento(validEvent)
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      eventId: "evt-unique-001",
      sequence: 1,
    })
  })

  it("corrida de entrega dupla: aceitarUmaVez chamado antes do POST → controller captura throw e responde duplicate:true", () => {
    // Simula a corrida: o id já está no Set eventosRecebidos, mas o envelope
    // ainda não foi indexado em envelopesPorId. publicar() vai lançar
    // 'Evento realtime duplicado' porque aceitarUmaVez interno retorna false.
    service.aceitarUmaVez("evt-race-001")
    const raceEvent = { ...validEvent, eventId: "evt-race-001" }
    const result = controller.aceitarEvento(raceEvent)
    expect(result).toEqual({
      ok: true,
      duplicate: true,
      eventId: "evt-race-001",
    })
  })

  it("corpo inválido lança BadRequestException", () => {
    expect(() => controller.aceitarEvento({ invalid: true })).toThrow(BadRequestException)
    expect(() => controller.aceitarEvento({ invalid: true })).toThrow("Evento realtime inválido")
  })

  it("Idempotency-Key divergente do eventId lança BadRequestException", () => {
    expect(() =>
      controller.aceitarEvento(validEvent, "chave-divergente"),
    ).toThrow(BadRequestException)
    expect(() =>
      controller.aceitarEvento(validEvent, "chave-divergente"),
    ).toThrow("Idempotency-Key divergente do eventId")
  })

  it("Idempotency-Key igual ao eventId não lança", () => {
    const result = controller.aceitarEvento(validEvent, validEvent.eventId)
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      eventId: "evt-unique-001",
      sequence: 1,
    })
  })

  it("erros diferentes de duplicado propagam", () => {
    // Forçar publicar() a lançar erro diferente de duplicado: evento inválido
    // internamente (schema do shared rejeita) — o controller já rejeita antes
    // com BadRequestException. Para testar propagação de erro inesperado,
    // mockamos um cenário onde publicar lança algo diferente.
    const corruptedService = service as unknown as {
      publicar: (e: unknown) => never
    }
    corruptedService.publicar = () => {
      throw new Error("erro inesperado de infraestrutura")
    }
    const ctrl = new RealtimeController(service)
    expect(() => ctrl.aceitarEvento(validEvent)).toThrow("erro inesperado de infraestrutura")
  })

  it("eventos com eventIds diferentes produzem sequences crescentes", () => {
    const r1 = controller.aceitarEvento(validEvent)
    const r2 = controller.aceitarEvento({
      ...validEvent,
      eventId: "evt-unique-002",
      payload: { title: "Segundo evento" },
    })
    expect(r1).toMatchObject({ ok: true, duplicate: false, sequence: 1 })
    expect(r2).toMatchObject({ ok: true, duplicate: false, sequence: 2 })
  })
})
