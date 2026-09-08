import { describe, expect, it } from "vitest"
import { authorizeTaskStatusTransition, isTaskStatusTransitionAllowed } from "../src/policies/TaskTransitionAuthorizationPolicy.js"

describe("TaskTransitionAuthorizationPolicy", () => {
  it("permite transições aprovadas ao Motor", () => {
    expect(isTaskStatusTransitionAllowed("planned", "analyzing", "motor")).toBe(true)
    expect(isTaskStatusTransitionAllowed("running", "paused", "motor")).toBe(true)
    expect(isTaskStatusTransitionAllowed("completed", "deployed", "motor")).toBe(true)
  })

  it("reserva draft -> running explicitamente ao Motor", () => {
    expect(authorizeTaskStatusTransition("draft", "running", "user")).toEqual({ allowed: false, reason: "reserved_for_motor" })
    expect(isTaskStatusTransitionAllowed("draft", "running", "motor")).toBe(true)
  })

  it("recusa destinos inválidos, legados e mudanças manuais", () => {
    expect(isTaskStatusTransitionAllowed("draft", "completed", "motor")).toBe(false)
    expect(isTaskStatusTransitionAllowed("completed", "finalizada", "motor")).toBe(false)
    expect(isTaskStatusTransitionAllowed("running", "completed", "user")).toBe(false)
  })

  it("permite no-op para drops na mesma estação", () => {
    expect(isTaskStatusTransitionAllowed("running", "running", "user")).toBe(true)
  })
})
