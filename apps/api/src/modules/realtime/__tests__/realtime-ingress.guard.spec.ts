// @vitest-environment node
import { describe, expect, it } from "vitest"
import { UnauthorizedException } from "@nestjs/common"
import { RealtimeIngressGuard } from "../realtime-ingress.guard"
import type { EnvService } from "../../../config/env.service"

function context(authorization?: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  } as never
}

describe("RealtimeIngressGuard", () => {
  it("aceita somente o token interno configurado", () => {
    const guard = new RealtimeIngressGuard({ libraryRealtimeEventsToken: "secret" } as EnvService)

    expect(guard.canActivate(context("Bearer secret"))).toBe(true)
    expect(() => guard.canActivate(context("Bearer wrong"))).toThrow(UnauthorizedException)
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException)
  })
})
