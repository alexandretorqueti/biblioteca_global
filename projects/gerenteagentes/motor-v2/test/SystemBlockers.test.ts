import { describe, expect, it } from "vitest"
import {
  isSystemBlocker,
  SYSTEM_BLOCK_COOLDOWN_SECONDS,
  SYSTEM_BLOCK_MAX_AUTO_RETRIES,
  SYSTEM_BLOCK_REASON_SQL_LIST,
} from "../src/policies/SystemBlockers.js"

/**
 * A retomada automática é o que dispensa o runbook quando o Motor/ambiente
 * falhou. O que ela NUNCA pode fazer é retomar bloqueio de entrega (o dev não
 * entregou, o gate reprovou, o deploy quebrou) — isso pularia validação.
 */
describe("SystemBlockers", () => {
  it("classifica as causas do próprio Motor/ambiente", () => {
    expect(isSystemBlocker("blocked_environment")).toBe(true)
    expect(isSystemBlocker("systemic_failure")).toBe(true)
    expect(isSystemBlocker("model_chain_exhausted")).toBe(true)
  })

  it("não retoma bloqueio de entrega, manual ou desconhecido", () => {
    for (const reason of [
      "deploy_failed",
      "integration_failed",
      "correction_failed",
      "manual_reconciliation",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(isSystemBlocker(reason)).toBe(false)
    }
  })

  it("aceita o caso real que exigia runbook (preflight git bloqueado)", () => {
    expect(isSystemBlocker("systemic_failure", "motor-v2:preflight git: blocked; projeto da tarefa: projects/x", "preflight git: blocked")).toBe(true)
    expect(isSystemBlocker("blocked_environment", "motor-v2:spawn git enoent", "spawn git ENOENT")).toBe(true)
    expect(isSystemBlocker("model_chain_exhausted", "", "Todos os modelos da cadeia falharam")).toBe(true)
  })

  it("deixa bloqueio de promoção para o fluxo de promoção, mesmo com causa de sistema", () => {
    expect(isSystemBlocker("systemic_failure", "motor-v2:repositório principal não está limpo: projects/x")).toBe(false)
    expect(isSystemBlocker("blocked_environment", "motor-v2:unknown", "Conflito no merge da branch da tarefa para a base")).toBe(false)
    expect(isSystemBlocker("systemic_failure", "motor-v2:falha na promoção da branch da tarefa: Timeout")).toBe(false)
  })

  it("mantém o recorte SQL e os limites explícitos", () => {
    expect(SYSTEM_BLOCK_REASON_SQL_LIST).toBe("('blocked_environment', 'systemic_failure', 'model_chain_exhausted')")
    expect(SYSTEM_BLOCK_MAX_AUTO_RETRIES).toBeGreaterThan(0)
    expect(SYSTEM_BLOCK_COOLDOWN_SECONDS).toBeGreaterThan(0)
  })
})
