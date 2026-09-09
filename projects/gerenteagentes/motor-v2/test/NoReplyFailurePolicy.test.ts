import { describe, expect, it } from "vitest"
import {
  AGENT_RUN_FAILED_WITHOUT_REPLY,
  classifyNoReplyFailure,
  computeEffectiveRetryLimit,
  computeNextRetryAt,
  computeNoReplyFingerprint,
  formatTerminalDiagnostic,
  hasExceededRetryLimit,
  isAgentRunFailureWithoutReply,
  isRepeatedNoReplyFailure,
} from "../src/policies/NoReplyFailurePolicy.js"

describe("NoReplyFailurePolicy — classificação", () => {
  it("classifica conteúdo null como runtime_unavailable", () => {
    const result = classifyNoReplyFailure(null)
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("runtime_unavailable")
    expect(result!.reason).toBe(AGENT_RUN_FAILED_WITHOUT_REPLY)
  })

  it("classifica conteúdo undefined como runtime_unavailable", () => {
    const result = classifyNoReplyFailure(undefined)
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("runtime_unavailable")
  })

  it("classifica sentinel explícito como runtime_unavailable", () => {
    const result = classifyNoReplyFailure(AGENT_RUN_FAILED_WITHOUT_REPLY)
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("runtime_unavailable")
  })

  it("classifica string vazia como remote_no_reply", () => {
    const result = classifyNoReplyFailure("")
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("remote_no_reply")
  })

  it("classifica string só espaços como remote_no_reply", () => {
    const result = classifyNoReplyFailure("   ")
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("remote_no_reply")
  })

  it("classifica não-string (objeto) como remote_no_reply", () => {
    const result = classifyNoReplyFailure({ state: "final" })
    expect(result).not.toBeNull()
    expect(result!.classification).toBe("remote_no_reply")
  })

  it("retorna null para conteúdo válido", () => {
    expect(classifyNoReplyFailure("Entrega concluída com sucesso")).toBeNull()
    expect(classifyNoReplyFailure("Código alterado nos arquivos X, Y, Z")).toBeNull()
  })

  it("isAgentRunFailureWithoutReply é consistente com classifyNoReplyFailure", () => {
    expect(isAgentRunFailureWithoutReply(null)).toBe(true)
    expect(isAgentRunFailureWithoutReply("")).toBe(true)
    expect(isAgentRunFailureWithoutReply("resposta válida")).toBe(false)
  })
})

describe("NoReplyFailurePolicy — fingerprint", () => {
  it("normaliza detalhes voláteis do motivo", () => {
    const fp = computeNoReplyFingerprint("runtime_unavailable", "Falha na sessão task-7-subtask-4 run abcdef12")
    expect(fp).toBe("runtime_unavailable:falha na sessão task-<n>-subtask-<n> run <sha>")
  })

  it("fingersprints iguais para o mesmo motivo normalizado", () => {
    const fp1 = computeNoReplyFingerprint("remote_no_reply", "Resposta vazia no run 123")
    const fp2 = computeNoReplyFingerprint("remote_no_reply", "Resposta vazia no run 456")
    expect(fp1).toBe(fp2)
  })

  it("fingersprints diferentes para classificações diferentes", () => {
    const fp1 = computeNoReplyFingerprint("remote_no_reply", "Falha")
    const fp2 = computeNoReplyFingerprint("runtime_unavailable", "Falha")
    expect(fp1).not.toBe(fp2)
  })
})

describe("NoReplyFailurePolicy — detector de falhas repetidas", () => {
  it("detecta falha repetida quando o fingerprint aparece N vezes", () => {
    const fp = "runtime_unavailable:falha na sessão"
    expect(isRepeatedNoReplyFailure([fp, fp], fp, 3)).toBe(true)
    expect(isRepeatedNoReplyFailure([fp], fp, 3)).toBe(false)
    expect(isRepeatedNoReplyFailure([], fp, 3)).toBe(false)
  })

  it("não detecta quando os fingerprints são diferentes", () => {
    const fp = "runtime_unavailable:falha"
    expect(isRepeatedNoReplyFailure(["outra:falha", "outra:falha"], fp, 3)).toBe(false)
  })

  it("threshold padrão é 3", () => {
    const fp = "remote_no_reply:vazia"
    expect(isRepeatedNoReplyFailure([fp, fp], fp)).toBe(true)
  })
})

describe("NoReplyFailurePolicy — limite efetivo", () => {
  it("usa maxRework + 1 como limite efetivo", () => {
    expect(computeEffectiveRetryLimit(3)).toBe(4)
    expect(computeEffectiveRetryLimit(0)).toBe(1)
    expect(computeEffectiveRetryLimit(7)).toBe(8)
  })

  it("default é 3 (limite 4) quando maxRework é null/undefined", () => {
    expect(computeEffectiveRetryLimit(null)).toBe(4)
    expect(computeEffectiveRetryLimit(undefined)).toBe(4)
  })

  it("hasExceededRetryLimit verifica o contador contra o limite", () => {
    expect(hasExceededRetryLimit(3, 3)).toBe(false) // 3 < 4
    expect(hasExceededRetryLimit(4, 3)).toBe(true)  // 4 >= 4
    expect(hasExceededRetryLimit(5, 3)).toBe(true)  // 5 >= 4
  })
})

describe("NoReplyFailurePolicy — backoff exponencial com jitter", () => {
  it("produz retry sempre no futuro", () => {
    const now = 1_000_000_000_000
    const next = computeNextRetryAt(1, { now: () => now, random: () => 0 })
    expect(next.getTime()).toBeGreaterThan(now)
  })

  it("é determinístico com relógio e aleatoriedade injetáveis", () => {
    const now = 1_000_000_000_000
    const deps = { now: () => now, random: () => 0.5 }
    const next1 = computeNextRetryAt(3, deps)
    const next2 = computeNextRetryAt(3, deps)
    expect(next1.getTime()).toBe(next2.getTime())
  })

  it("backoff cresce exponencialmente com o attempt", () => {
    const now = 1_000_000_000_000
    const deps = { now: () => now, random: () => 0 }
    const next1 = computeNextRetryAt(1, deps)
    const next2 = computeNextRetryAt(2, deps)
    const next3 = computeNextRetryAt(3, deps)
    const delay1 = next1.getTime() - now
    const delay2 = next2.getTime() - now
    const delay3 = next3.getTime() - now
    // Sem jitter: 30s, 60s, 120s
    expect(delay1).toBe(30_000)
    expect(delay2).toBe(60_000)
    expect(delay3).toBe(120_000)
  })

  it("jitter adiciona variação dentro do range exponencial", () => {
    const now = 1_000_000_000_000
    const depsMin = { now: () => now, random: () => 0 }
    const depsMax = { now: () => now, random: () => 0.99 }
    const nextMin = computeNextRetryAt(2, depsMin)
    const nextMax = computeNextRetryAt(2, depsMax)
    // attempt=2: base=60s, jitter=[0, 60s)
    expect(nextMin.getTime() - now).toBe(60_000)
    expect(nextMax.getTime() - now).toBeGreaterThan(60_000)
    expect(nextMax.getTime() - now).toBeLessThan(120_000)
  })

  it("attempt mínimo é 1 (não produz delay negativo)", () => {
    const now = 1_000_000_000_000
    const next = computeNextRetryAt(0, { now: () => now, random: () => 0 })
    expect(next.getTime() - now).toBe(30_000) // treated as attempt=1
  })
})

describe("NoReplyFailurePolicy — diagnóstico terminal", () => {
  it("formata diagnóstico legível com todos os campos", () => {
    const diag = formatTerminalDiagnostic(
      "runtime_unavailable",
      8,
      3,
      "runtime_unavailable:falha na sessão",
      "The agent run failed before producing a reply.",
    )
    expect(diag).toContain("Falha terminal: runtime_unavailable")
    expect(diag).toContain("Tentativas: 8/4")
    expect(diag).toContain("Fingerprint: runtime_unavailable:falha na sessão")
    expect(diag).toContain("Último motivo:")
  })
})
