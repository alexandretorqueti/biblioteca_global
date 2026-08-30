import { describe, expect, it } from "vitest"
import { transitionTask } from "../src/policies/TaskStateMachine.js"

describe("TaskStateMachine", () => {
  it("persiste falha que chega após a tarefa ser pausada", () => {
    expect(transitionTask("paused", "fail")).toBe("blocked")
  })
})
