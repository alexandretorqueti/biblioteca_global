// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JwtService } from "@nestjs/jwt"
import { RealtimeTicketController } from "../realtime-ticket.controller"
import type { ApiRequest } from "../../../common/types"

describe("RealtimeTicketController", () => {
  let controller: RealtimeTicketController
  let jwt: JwtService

  beforeEach(() => {
    jwt = {
      signAsync: vi.fn().mockResolvedValue("ticket-jwt-mock"),
    } as unknown as JwtService
    controller = new RealtimeTicketController(jwt)
  })

  it("gera ticket com claims sub, projetoId e kind=ws-ticket", async () => {
    const req = { authClaims: { sub: 42, projetoId: 7, perfil: "admin" } } as ApiRequest
    const result = await controller.gerarTicket(req)
    expect(result).toEqual({ ticket: "ticket-jwt-mock" })
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: 42, projetoId: 7, kind: "ws-ticket" },
      { expiresIn: "30s" },
    )
  })

  it("lança erro se authClaims estiver ausente", async () => {
    const req = {} as ApiRequest
    await expect(controller.gerarTicket(req)).rejects.toThrow("claims ausentes")
  })
})
