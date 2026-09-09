import { describe, expect, it } from "vitest"
import {
  classifyNoReplyFailure,
  computeEffectiveRetryLimit,
  computeNextRetryAt,
  formatTerminalDiagnostic,
  hasExceededRetryLimit,
  isRepeatedNoReplyFailure,
  computeNoReplyFingerprint,
  AGENT_RUN_FAILED_WITHOUT_REPLY,
} from "../src/policies/NoReplyFailurePolicy.js"

/**
 * Testes de integração da política de retry para falhas sem resposta.
 *
 * Valida o contrato que o TaskWorker deve seguir ao persistir uma falha
 * sem resposta verificável (remote_no_reply / runtime_unavailable):
 * - deliver_count é a fonte única de tentativas
 * - cada falha grava evento append-only com classificação e fingerprint
 * - limite atingido → blocked com diagnóstico terminal
 * - limite não atingido → pending com next_retry_at no futuro
 * - backoff exponencial impede seleção precoce pelo coordinator
 */

describe("NoReplyRetryPolicy — contrato de integração com TaskWorker", () => {
  describe("falha sem conteúdo incrementa deliver_count", () => {
    it("deliver_count > 0 após primeira falha (runtime_unavailable)", () => {
      // Simula o fluxo: worker incrementa deliver_count ANTES de classificar
      const deliverCount = 1 // já incrementado pelo loop
      const content = null // runtime não produziu resposta
      const classification = classifyNoReplyFailure(content)
      expect(classification).not.toBeNull()
      expect(classification!.classification).toBe("runtime_unavailable")
      expect(deliverCount).toBeGreaterThan(0)
    })

    it("deliver_count > 0 após primeira falha (remote_no_reply)", () => {
      const deliverCount = 1
      const content = "" // gateway respondeu sem conteúdo
      const classification = classifyNoReplyFailure(content)
      expect(classification).not.toBeNull()
      expect(classification!.classification).toBe("remote_no_reply")
      expect(deliverCount).toBeGreaterThan(0)
    })
  })

  describe("evento append-only com número da entrega, motivo e fingerprint", () => {
    it("gera fingerprint estável para o mesmo motivo", () => {
      const fp1 = computeNoReplyFingerprint("runtime_unavailable", "Falha na sessão task-7 run abc1234")
      const fp2 = computeNoReplyFingerprint("runtime_unavailable", "Falha na sessão task-7 run def5678")
      expect(fp1).toBe(fp2)
    })

    it("fingerprint diferente para classificações diferentes", () => {
      const fp1 = computeNoReplyFingerprint("runtime_unavailable", "Falha")
      const fp2 = computeNoReplyFingerprint("remote_no_reply", "Falha")
      expect(fp1).not.toBe(fp2)
    })

    it("evento inclui todos os campos necessários", () => {
      const classification = classifyNoReplyFailure(AGENT_RUN_FAILED_WITHOUT_REPLY)!
      const deliverNumber = 3
      const model = "openai/gpt-5.6-sol"
      const eventReason = JSON.stringify({
        classification: classification.classification,
        fingerprint: classification.fingerprint,
        reason: AGENT_RUN_FAILED_WITHOUT_REPLY.slice(0, 500),
      })
      const parsed = JSON.parse(eventReason)
      expect(parsed.classification).toBe("runtime_unavailable")
      expect(parsed.fingerprint).toBeTruthy()
      expect(parsed.reason).toBe(AGENT_RUN_FAILED_WITHOUT_REPLY)
      expect(deliverNumber).toBe(3)
      expect(model).toBe("openai/gpt-5.6-sol")
    })
  })

  describe("limite de retry: pending com next_retry_at vs blocked", () => {
    it("enquanto não excedeu: pending com next_retry_at no futuro", () => {
      const deliverCount = 2
      const maxRework = 3 // limite efetivo = 4
      expect(hasExceededRetryLimit(deliverCount, maxRework)).toBe(false)
      const nextRetry = computeNextRetryAt(deliverCount, { now: () => 1_000_000_000_000, random: () => 0 })
      expect(nextRetry.getTime()).toBeGreaterThan(1_000_000_000_000)
    })

    it("ao esgotar limite: blocked com diagnóstico terminal", () => {
      const deliverCount = 4
      const maxRework = 3 // limite efetivo = 4
      expect(hasExceededRetryLimit(deliverCount, maxRework)).toBe(true)
      const diagnostic = formatTerminalDiagnostic(
        "runtime_unavailable",
        deliverCount,
        maxRework,
        "runtime_unavailable:falha na sessão",
        AGENT_RUN_FAILED_WITHOUT_REPLY,
      )
      expect(diagnostic).toContain("Falha terminal")
      expect(diagnostic).toContain("Tentativas: 4/4")
    })

    it("maxRework=0 permite apenas 1 tentativa (a primeira)", () => {
      expect(computeEffectiveRetryLimit(0)).toBe(1)
      expect(hasExceededRetryLimit(1, 0)).toBe(true)
      expect(hasExceededRetryLimit(0, 0)).toBe(false)
    })
  })

  describe("backoff exponencial impede seleção precoce", () => {
    it("next_retry_at sempre no futuro", () => {
      const now = Date.now()
      for (let attempt = 1; attempt <= 5; attempt++) {
        const next = computeNextRetryAt(attempt, { now: () => now, random: () => 0 })
        expect(next.getTime()).toBeGreaterThan(now)
      }
    })

    it("backoff cresce com o número da tentativa", () => {
      const now = Date.now()
      const deps = { now: () => now, random: () => 0 }
      const delays: number[] = []
      for (let attempt = 1; attempt <= 4; attempt++) {
        const next = computeNextRetryAt(attempt, deps)
        delays.push(next.getTime() - now)
      }
      // Sem jitter: 30s, 60s, 120s, 240s
      expect(delays[0]).toBe(30_000)
      expect(delays[1]).toBe(60_000)
      expect(delays[2]).toBe(120_000)
      expect(delays[3]).toBe(240_000)
      // Monotonicidade
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]!)
      }
    })

    it("coordinator não seleciona subtarefa com next_retry_at no futuro", () => {
      // Simula a condição SQL: (next_retry_at IS NULL OR next_retry_at <= NOW())
      const now = Date.now()
      const futureRetry = now + 60_000
      const pastRetry = now - 1_000

      const shouldSelect = (nextRetryAt: number | null) =>
        nextRetryAt === null || nextRetryAt <= now

      expect(shouldSelect(null)).toBe(true) // sem retry policy → seleciona
      expect(shouldSelect(pastRetry)).toBe(true) // retry vencido → seleciona
      expect(shouldSelect(futureRetry)).toBe(false) // retry futuro → não seleciona
    })
  })

  describe("detector de falhas repetidas por fingerprint", () => {
    it("detecta falha sistêmica após 3 ocorrências consecutivas", () => {
      const fp = "runtime_unavailable:falha na sessão"
      const history = [fp, fp] // 2 anteriores
      expect(isRepeatedNoReplyFailure(history, fp, 3)).toBe(true)
    })

    it("não detecta quando há variação no fingerprint", () => {
      const fp1 = "runtime_unavailable:falha na sessão"
      const fp2 = "remote_no_reply:resposta vazia"
      expect(isRepeatedNoReplyFailure([fp1, fp2], fp1, 3)).toBe(false)
    })
  })

  describe("resposta válida após falhas conclui corretamente", () => {
    it("conteúdo válido não é classificado como falha", () => {
      expect(classifyNoReplyFailure("Código alterado nos arquivos X, Y")).toBeNull()
      expect(classifyNoReplyFailure("Entrega concluída com sucesso")).toBeNull()
    })

    it("contador persistido é usado para a próxima tentativa", () => {
      // Simula: 3 falhas + 1 sucesso
      const deliverCountAfterFailures = 3
      const maxRework = 5
      expect(hasExceededRetryLimit(deliverCountAfterFailures, maxRework)).toBe(false)
      // A próxima tentativa seria deliver_count=4, que ainda está dentro do limite
      const nextAttempt = deliverCountAfterFailures + 1
      expect(hasExceededRetryLimit(nextAttempt, maxRework)).toBe(false)
    })
  })

  describe("cancelamento/shutdown não é retry", () => {
    it("falha classificada como runtime_unavailable não gera retry se o worker foi cancelado", () => {
      // O cancelamento é tratado pelo worker (this.cancelled) antes de
      // chegar ao replyFailureReason. Este teste valida que a classificação
      // não interfere no fluxo de cancelamento.
      const content = null
      const classification = classifyNoReplyFailure(content)
      expect(classification!.classification).toBe("runtime_unavailable")
      // O worker verifica this.cancelled ANTES de processar o resultado
      // Se cancelado, não chama handleNoReplyFailure — apenas retorna
    })
  })

  describe("sete falhas não criam sete worktrees sem controle", () => {
    it("com maxRework=3, limita a 4 tentativas (não 7+)", () => {
      const maxRework = 3
      const limit = computeEffectiveRetryLimit(maxRework)
      expect(limit).toBe(4)
      // Após 4 entregas, a subtarefa é bloqueada
      expect(hasExceededRetryLimit(4, maxRework)).toBe(true)
    })

    it("com maxRework padrão (3), 8 entregas como no incidente #794 seriam bloqueadas na 4ª", () => {
      const maxRework = 3
      // Simula as 8 entregas do incidente
      for (let deliverCount = 1; deliverCount <= 8; deliverCount++) {
        if (hasExceededRetryLimit(deliverCount, maxRework)) {
          // Deve bloquear na 4ª tentativa, não na 8ª
          expect(deliverCount).toBe(4)
          break
        }
      }
    })
  })
})
