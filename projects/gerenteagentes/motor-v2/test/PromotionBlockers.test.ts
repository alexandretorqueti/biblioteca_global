import { describe, expect, it } from "vitest"
import {
  isPromotionBlocker,
  isPromotionConflictBlocker,
  isPromotionDirtyBlocker,
  isPromotionFailureBlocker,
  promotionBlockerSqlFilter,
  PROMOTION_BLOCKER_SQL_FILTER,
  PROMOTION_CONFLICT_SQL_FILTER,
  PROMOTION_DIRTY_SQL_FILTER,
  PROMOTION_FAILURE_SQL_FILTER,
} from "../src/policies/PromotionBlockers.js"

const structuredConflict = "motor-v2:promotion-conflict:base-desenvolvimento:motor-v2%2Ftask-p2-792%2Fintegracao:deadbeef"
const legacyConflictExcerpt = "Conflito no merge da branch da tarefa para a base (base-desenvolvimento) — resolução humana necessária."
const structuredDirty = "motor-v2:promotion-repo-dirty:base-desenvolvimento:motor-v2%2Ftask-p2-810%2Fintegracao:2"
const legacyDirtyExcerpt = "Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção: apps/web/x.tsx"
// 3ª variante legada (citada pelo Alexandre): comando direto, sem o prefixo estruturado.
const legacyDirtyCommand = "motor-v2:repositório principal não está limpo: projects/gerenteagentes/docs/CONTROLES-PROMOCAO.md"
const legacyDirtyIntegrationCommand = "motor-v2:integração falhou: repositório principal não está limpo para integração: apps/web/y.tsx"
// Família "falha na promoção" genérica (ex.: timeout no lock de integração do #784).
const legacyFailureCommand = "motor-v2:falha na promoção da branch da tarefa: Timeout adquirindo lock de integração do projeto"
const legacyFailureExcerpt = "Falha na promoção da branch da tarefa: Timeout adquirindo lock de integração do projeto biblioteca-global"

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

  it("reconhece a 3ª variante legada de repo sujo (comando direto)", () => {
    expect(isPromotionDirtyBlocker(legacyDirtyCommand)).toBe(true)
    expect(isPromotionDirtyBlocker(legacyDirtyIntegrationCommand)).toBe(true)
    expect(isPromotionDirtyBlocker("motor-v2:unknown", "repositório principal não está limpo: projects/x")).toBe(true)
  })

  it("reconhece a família genérica de falha na promoção sem confundir com sujo/conflito", () => {
    expect(isPromotionFailureBlocker(legacyFailureCommand, legacyFailureExcerpt)).toBe(true)
    expect(isPromotionBlocker(legacyFailureCommand, legacyFailureExcerpt)).toBe(true)
    expect(isPromotionBlocker("motor-v2:x", legacyFailureExcerpt)).toBe(true)
    expect(isPromotionConflictBlocker(legacyFailureCommand, legacyFailureExcerpt)).toBe(false)
    expect(isPromotionDirtyBlocker(legacyFailureCommand, legacyFailureExcerpt)).toBe(false)
  })

  it("não trata falha de sistema/integração comum como bloqueio de promoção", () => {
    expect(isPromotionBlocker("motor-v2:preflight git: blocked", "preflight git: blocked; projeto da tarefa: projects/x")).toBe(false)
    expect(isPromotionBlocker("motor-v2:falha sistêmica repetida entre modelos: 3 tentativas", "Falha sistêmica repetida entre modelos")).toBe(false)
    expect(isPromotionBlocker("motor-v2:integração falhou: git switch -c motor-v2/task/integracao", "integração git falhou")).toBe(false)
    expect(isPromotionBlocker("", "deploy falhou: 502 no healthcheck")).toBe(false)
  })

  it("mantém os recortes SQL alinhados aos prefixos reconhecidos", () => {
    expect(PROMOTION_CONFLICT_SQL_FILTER).toContain("motor-v2:promotion-conflict:")
    expect(PROMOTION_DIRTY_SQL_FILTER).toContain("motor-v2:promotion-repo-dirty:")
    expect(PROMOTION_DIRTY_SQL_FILTER).toContain("motor-v2:repositório principal não está limpo:")
    expect(PROMOTION_DIRTY_SQL_FILTER).toContain("%repositório principal não está limpo%")
    expect(PROMOTION_FAILURE_SQL_FILTER).toContain("motor-v2:falha na promoção da branch da tarefa:")
    expect(PROMOTION_BLOCKER_SQL_FILTER).toBe(
      `(${PROMOTION_CONFLICT_SQL_FILTER} OR ${PROMOTION_DIRTY_SQL_FILTER} OR ${PROMOTION_FAILURE_SQL_FILTER})`,
    )
  })

  it("permite o mesmo recorte em sub-selects com outro alias", () => {
    const sql = promotionBlockerSqlFilter("b2")
    expect(sql).toContain("b2.block_command")
    expect(sql).not.toContain(" b.block_command")
  })
})
