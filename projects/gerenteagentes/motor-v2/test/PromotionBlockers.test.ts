import { describe, expect, it } from "vitest"
import {
  isPromotionBlocker,
  isPromotionConflictBlocker,
  isPromotionDirtyBlocker,
  PROMOTION_BLOCKER_SQL_FILTER,
  PROMOTION_CONFLICT_SQL_FILTER,
  PROMOTION_DIRTY_SQL_FILTER,
} from "../src/policies/PromotionBlockers.js"

const structuredConflict = "motor-v2:promotion-conflict:base-desenvolvimento:motor-v2%2Ftask-p2-792%2Fintegracao:deadbeef"
const legacyConflictExcerpt = "Conflito no merge da branch da tarefa para a base (base-desenvolvimento) — resolução humana necessária."
const structuredDirty = "motor-v2:promotion-repo-dirty:base-desenvolvimento:motor-v2%2Ftask-p2-810%2Fintegracao:2"
const legacyDirtyExcerpt = "Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção: apps/web/x.tsx"

describe("PromotionBlockers", () => {
  it("reconhece conflito estruturado e legado", () => {
    expect(isPromotionConflictBlocker(structuredConflict)).toBe(true)
    expect(isPromotionConflictBlocker("motor-v2:unknown", legacyConflictExcerpt)).toBe(true)
    expect(isPromotionConflictBlocker("motor-v2:unknown", "texto qualquer")).toBe(false)
  })

  it("reconhece repo sujo estruturado e legado", () => {
    expect(isPromotionDirtyBlocker(structuredDirty)).toBe(true)
    expect(isPromotionDirtyBlocker("motor-v2:unknown", legacyDirtyExcerpt)).toBe(true)
    expect(isPromotionDirtyBlocker("motor-v2:unknown", "texto qualquer")).toBe(false)
  })

  it("não confunde um fluxo com o outro", () => {
    expect(isPromotionDirtyBlocker(structuredConflict)).toBe(false)
    expect(isPromotionConflictBlocker(structuredDirty)).toBe(false)
    expect(isPromotionConflictBlocker("motor-v2:x", legacyDirtyExcerpt)).toBe(false)
    expect(isPromotionDirtyBlocker("motor-v2:x", legacyConflictExcerpt)).toBe(false)
  })

  it("agrega os dois fluxos em isPromotionBlocker", () => {
    for (const [command, excerpt] of [[structuredConflict, ""], [structuredDirty, ""], ["motor-v2:x", legacyConflictExcerpt], ["motor-v2:x", legacyDirtyExcerpt]]) {
      expect(isPromotionBlocker(command, excerpt)).toBe(true)
    }
    expect(isPromotionBlocker("motor-v2:x", "nada")).toBe(false)
  })

  it("mantém os recortes SQL alinhados aos prefixos reconhecidos", () => {
    expect(PROMOTION_CONFLICT_SQL_FILTER).toContain("motor-v2:promotion-conflict:")
    expect(PROMOTION_DIRTY_SQL_FILTER).toContain("motor-v2:promotion-repo-dirty:")
    expect(PROMOTION_BLOCKER_SQL_FILTER).toBe(`(${PROMOTION_CONFLICT_SQL_FILTER} OR ${PROMOTION_DIRTY_SQL_FILTER})`)
  })
})
