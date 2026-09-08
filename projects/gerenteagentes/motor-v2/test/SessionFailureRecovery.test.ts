import { describe, expect, it } from "vitest"
import { classifyRemoteFailure } from "../src/runtime/ConsoleAgentRuntimeDriver.js"
import { formatRemoteSessionFailure, resolveSessionRecoveryLimit } from "../src/workers/TaskWorker.js"

describe("política de recuperação de sessão", () => {
  it("classifica falha definitiva e não permite recuperação indevida", () => {
    expect(classifyRemoteFailure("INVALID_SESSION", "session key inválida")).toBe("definitive")
    expect(classifyRemoteFailure("AGENT_NOT_FOUND", "agente inexistente")).toBe("definitive")
  })

  it("classifica indisponibilidade compartilhada como sistêmica", () => {
    expect(classifyRemoteFailure("GATEWAY_UNAVAILABLE", "Console indisponível")).toBe("systemic")
    expect(classifyRemoteFailure("GATEWAY_DOWN", "Console indisponível")).toBe("systemic")
  })

  it("mantém limite explícito contra loop de recuperação", () => {
    expect(resolveSessionRecoveryLimit({ MOTOR_SESSION_RECOVERY_MAX_ATTEMPTS: "2" })).toBe(2)
    expect(resolveSessionRecoveryLimit({ MOTOR_SESSION_RECOVERY_MAX_ATTEMPTS: "99" })).toBe(1)
    expect(resolveSessionRecoveryLimit({ MOTOR_SESSION_RECOVERY_MAX_ATTEMPTS: "0" })).toBe(0)
  })

  it("formata causa remota com rastreabilidade suficiente para o bloqueio", () => {
    const reason = formatRemoteSessionFailure({
      code: "INVALID_SESSION",
      message: "sessão inválida",
      sessionKey: "task-7-subtask-4",
      remoteSessionId: "remote-4",
      runId: "run-9",
      occurredAt: "2026-09-08T12:00:00.000Z",
      scope: "session",
      classification: "definitive",
      classificationReason: "remote_failure_default_classification",
      fingerprint: "INVALID_SESSION:sessão inválida",
    })
    expect(reason).toContain("INVALID_SESSION")
    expect(reason).toContain("task-7-subtask-4")
    expect(reason).toContain("run-9")
    expect(reason).toContain("2026-09-08T12:00:00.000Z")
  })
})
