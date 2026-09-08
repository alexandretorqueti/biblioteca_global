import { describe, expect, it } from "vitest"
import { validatePlanQuality } from "../src/planning/PlanQualityPolicy.js"
import type { PlanCoverage, PlannedSubtask } from "../src/planning/PlanPersistence.js"

const subtask = (overrides: Partial<PlannedSubtask> = {}): PlannedSubtask => ({
  seq: 1, titulo: "Persistir dados do recurso", scope: "Criar a persistência e validar o comportamento no banco do projeto.",
  acceptanceCriteria: ["Migration aplicada sem erro", "Dados podem ser lidos"], deliverables: ["migration", "teste"], requirementsCovered: ["REQ-1"], dependsOn: [], ...overrides,
})
const coverage: PlanCoverage = { requirements: [{ id: "REQ-1", description: "Persistência do recurso" }], coverage: [{ requirement: "REQ-1", coveredBy: [1] }] }

describe("validatePlanQuality", () => {
  it("aceita plano detalhado com cobertura completa", () => expect(validatePlanQuality([subtask()], coverage)).toEqual({ ok: true }))
  it("rejeita subtask genérica ou sem entregáveis", () => expect(validatePlanQuality([subtask({ titulo: "Implementar alteração", deliverables: [] })], coverage)).toMatchObject({ ok: false }))
  it("rejeita requisito sem cobertura", () => expect(validatePlanQuality([subtask()], { ...coverage, coverage: [] })).toMatchObject({ ok: false }))
  it("rejeita dependência para sequência inexistente", () => expect(validatePlanQuality([subtask({ dependsOn: [2] })], coverage)).toMatchObject({ ok: false }))
  it("rejeita plano que omite etapas numeradas explicitamente", () => expect(validatePlanQuality([subtask()], coverage, "1. Persistência\n2. API\n3. Testes")).toMatchObject({ ok: false }))
})
