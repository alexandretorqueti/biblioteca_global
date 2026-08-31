import { describe, expect, it } from "vitest"
import { transitionTask } from "../src/policies/TaskStateMachine.js"

describe("TaskStateMachine", () => {
  it("persiste falha ambiental que chega antes do início da análise", () => {
    expect(transitionTask("planned", "fail")).toBe("blocked")
  })

  it("persiste falha ambiental com a tarefa pronta aguardando subtarefa (ready)", () => {
    expect(transitionTask("ready", "fail")).toBe("blocked")
  })

  it("persiste falha que chega após a tarefa ser pausada", () => {
    expect(transitionTask("paused", "fail")).toBe("blocked")
  })
})
