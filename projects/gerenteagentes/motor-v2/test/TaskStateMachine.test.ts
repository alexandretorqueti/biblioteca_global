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

  it("analista pergunta: analyzing -> awaiting_clarification", () => {
    expect(transitionTask("analyzing", "await_clarification")).toBe("awaiting_clarification")
  })

  it("resposta recebida: awaiting_clarification volta para planned (reanálise)", () => {
    expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")
  })

  it("tarefa aguardando esclarecimento pode ser cancelada ou bloqueada", () => {
    expect(transitionTask("awaiting_clarification", "cancel")).toBe("cancelled")
    expect(transitionTask("awaiting_clarification", "fail")).toBe("blocked")
  })

  it("não permite pedir clarificação fora da análise", () => {
    expect(() => transitionTask("planned", "await_clarification")).toThrow()
    expect(() => transitionTask("running", "await_clarification")).toThrow()
  })

  it("não permite responder clarificação sem estar aguardando", () => {
    expect(() => transitionTask("planned", "clarification_answered")).toThrow()
    expect(() => transitionTask("analyzing", "clarification_answered")).toThrow()
  })

  it("analista apresenta proposta: analyzing -> awaiting_approval", () => {
    expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
  })

  it("dono aprova o plano: awaiting_approval -> ready", () => {
    expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
  })

  it("dono pede ajustes: awaiting_approval -> planned (reanálise na mesma sessão)", () => {
    expect(transitionTask("awaiting_approval", "request_adjustments")).toBe("planned")
  })

  it("não permite aprovar plano fora de awaiting_approval", () => {
    expect(() => transitionTask("planned", "approve_plan")).toThrow()
    expect(() => transitionTask("analyzing", "approve_plan")).toThrow()
    expect(() => transitionTask("running", "approve_plan")).toThrow()
  })

  it("não permite propor plano fora da análise", () => {
    expect(() => transitionTask("planned", "propose_plan")).toThrow()
    expect(() => transitionTask("running", "propose_plan")).toThrow()
  })

  it("tarefa aguardando aprovação pode ser cancelada ou bloqueada", () => {
    expect(transitionTask("awaiting_approval", "cancel")).toBe("cancelled")
    expect(transitionTask("awaiting_approval", "fail")).toBe("blocked")
  })
})
