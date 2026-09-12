import { describe, expect, it } from "vitest"
import { classifyRemoteFailure } from "../src/runtime/ConsoleAgentRuntimeDriver.js"
import { formatRemoteSessionFailure, remoteFailureSignature, resolveSessionRecoveryLimit, shouldEscalateAnalysisContextFailure } from "../src/workers/TaskWorker.js"

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

  // O Console devolve só status=failed: sem assinatura estável não há como saber
  // que a falha está se repetindo e que o modelo precisa ser escalado.
  it("agrupa falhas idênticas ignorando run e timestamp", () => {
    const a = remoteFailureSignature("SESSION_FAILED", "Session failed (sessão=agent:x, run=7a83cae5-7454-4da5-8bb1-dc380987dbed, ocorrido_em=2026-09-11T17:31:38.878Z)")
    const b = remoteFailureSignature("SESSION_FAILED", "Session failed (sessão=agent:x, run=d4bf64a4-cce7-47cc-af5b-2d3a6768bac2, ocorrido_em=2026-09-11T17:31:57.553Z)")
    expect(a).toBe(b)
    expect(remoteFailureSignature("SESSION_FAILED", "outro motivo")).not.toBe(a)
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

  it("promove o modelo quando o Console oculta a causa da falha de contexto", () => {
    expect(shouldEscalateAnalysisContextFailure({
      code: "SESSION_FAILED", message: "Session failed", sessionKey: "analysis-qwen-task-812",
      runId: "run-1", occurredAt: "2026-09-11T20:00:00.000Z", scope: "session",
      classification: "transient", classificationReason: "retryable", fingerprint: "SESSION_FAILED:Session failed",
    }, "Session failed")).toBe(true)
  })

  it("promove o modelo quando a sessão informa modelo indisponível", () => {
    expect(shouldEscalateAnalysisContextFailure({
      code: "SESSION_FAILED",
      message: "Modelo indisponível: alibaba/qwen3.7-plus — [SESSION_FAILED] Session failed",
      sessionKey: "dev-qwen3.7-plus-task-p2-816-s1033",
      runId: "ec5dc24a-06d7-47ce-aab0-f51c8eefb197",
      occurredAt: "2026-09-12T01:02:13.409Z",
      scope: "session",
      classification: "transient",
      classificationReason: "retryable",
      fingerprint: "SESSION_FAILED:Modelo indisponível",
    }, "Modelo indisponível: alibaba/qwen3.7-plus")).toBe(true)
  })

  it("não troca de modelo quando a infraestrutura compartilhada caiu", () => {
    expect(shouldEscalateAnalysisContextFailure({
      code: "GATEWAY_DOWN", message: "Console indisponível", sessionKey: "analysis-qwen-task-812",
      runId: "run-2", occurredAt: "2026-09-11T20:00:00.000Z", scope: "console",
      classification: "systemic", classificationReason: "shared_console_failure", fingerprint: "GATEWAY_DOWN:Console indisponível",
    }, "Console indisponível")).toBe(false)
  })
})
