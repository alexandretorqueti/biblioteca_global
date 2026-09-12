import { describe, expect, it } from "vitest"
import { RecoveryEligibilityState, verifyRecoveryEligibility } from "../src/shared/recoveryEligibility.js"

const base = { status: "blocked", blockers: [{ reason: "systemic_failure", blockedAt: "2026-09-12T00:00:00.000Z" }], resolvedSystemBlockCount24h: 0, now: new Date("2026-09-12T00:00:30.000Z") }

describe("recoveryEligibility", () => {
  it.each([
    [RecoveryEligibilityState.Cooldown, { }],
    [RecoveryEligibilityState.Eligible, { now: new Date("2026-09-12T00:02:00.000Z") }],
    [RecoveryEligibilityState.MaxRetries, { resolvedSystemBlockCount24h: 3 }],
    [RecoveryEligibilityState.MonitorCorrecting, { activeLease: { executionId: "e1", ownerId: "s1", resourceKey: "motor:monitor", expiresAt: "2026-09-12T00:10:00.000Z" } }],
    [RecoveryEligibilityState.AwaitingUser, { pendingQuestion: { askedAt: "2026-09-12T00:00:10.000Z", text: "?" } }],
  ])("retorna %s", (state, overrides) => expect(verifyRecoveryEligibility({ ...base, ...overrides })).toMatchObject({ state }))

  it("prioriza bloqueio de promoção", () => expect(verifyRecoveryEligibility({ ...base, blockers: [{ reason: "systemic_failure", command: "motor-v2:promotion-conflict:x", blockedAt: base.blockers[0].blockedAt }] })).toMatchObject({ state: RecoveryEligibilityState.PromotionBlocked }))
  it("retorna nulo para tarefa não bloqueada", () => expect(verifyRecoveryEligibility({ ...base, status: "ready" })).toBeNull())
})
