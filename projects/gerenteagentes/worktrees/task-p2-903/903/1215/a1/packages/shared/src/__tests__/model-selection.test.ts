import { describe, expect, it } from "vitest"
import {
  ModelSelectionEntrySchema,
  ModelSelectionTipoSchema,
  ProjectModelSelectionSchema,
} from "../index.js"
import type { ProjectModelSelection } from "../index.js"

describe("model-selection (espelha o contrato do motor)", () => {
  it("ModelSelectionTipoSchema aceita apenas DEV/ANALYST/MONITOR", () => {
    expect(ModelSelectionTipoSchema.safeParse("DEV").success).toBe(true)
    expect(ModelSelectionTipoSchema.safeParse("ANALYST").success).toBe(true)
    expect(ModelSelectionTipoSchema.safeParse("MONITOR").success).toBe(true)
    expect(ModelSelectionTipoSchema.safeParse("dev").success).toBe(false)
    expect(ModelSelectionTipoSchema.safeParse("").success).toBe(false)
  })

  it("ModelSelectionEntrySchema valida campos e aplica default enabled=true", () => {
    const ok = ModelSelectionEntrySchema.parse({
      ordem: 1,
      provider: "ollama",
      model: "qwen3.8:27b",
    })
    expect(ok).toEqual({
      ordem: 1,
      provider: "ollama",
      model: "qwen3.8:27b",
      enabled: true,
    })

    const comDefault = ModelSelectionEntrySchema.parse({
      ordem: 2,
      provider: "openai",
      model: "gpt-5.6",
      enabled: false,
    })
    expect(comDefault.enabled).toBe(false)

    // ordem deve ser inteiro >= 1
    expect(
      ModelSelectionEntrySchema.safeParse({
        ordem: 0,
        provider: "x",
        model: "y",
      }).success,
    ).toBe(false)
    expect(
      ModelSelectionEntrySchema.safeParse({
        ordem: 1.5,
        provider: "x",
        model: "y",
      }).success,
    ).toBe(false)

    // provider/model vazios ou com whitespace puro são rejeitados
    expect(
      ModelSelectionEntrySchema.safeParse({
        ordem: 1,
        provider: "   ",
        model: "y",
      }).success,
    ).toBe(false)
    expect(
      ModelSelectionEntrySchema.safeParse({
        ordem: 1,
        provider: "x",
        model: "  ",
      }).success,
    ).toBe(false)

    // schema é strict: campo extra é rejeitado
    expect(
      ModelSelectionEntrySchema.safeParse({
        ordem: 1,
        provider: "x",
        model: "y",
        extra: 1,
      }).success,
    ).toBe(false)
  })

  it("ProjectModelSelectionSchema exige entries não vazias e é strict", () => {
    const sel: ProjectModelSelection = ProjectModelSelectionSchema.parse({
      projectKey: "gerenteagentes",
      tipo: "DEV",
      entries: [
        { ordem: 1, provider: "ollama", model: "qwen3.8:27b" },
        { ordem: 2, provider: "openai", model: "gpt-5.6", enabled: false },
      ],
    })
    expect(sel.projectKey).toBe("gerenteagentes")
    expect(sel.tipo).toBe("DEV")
    expect(sel.entries).toHaveLength(2)

    // entries vazias é rejeitado (min 1)
    expect(
      ProjectModelSelectionSchema.safeParse({
        projectKey: "x",
        tipo: "DEV",
        entries: [],
      }).success,
    ).toBe(false)

    // projectKey vazio é rejeitado
    expect(
      ProjectModelSelectionSchema.safeParse({
        projectKey: "   ",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "p", model: "m" }],
      }).success,
    ).toBe(false)

    // campo extra no topo é rejeitado (strict)
    expect(
      ProjectModelSelectionSchema.safeParse({
        projectKey: "x",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "p", model: "m" }],
        outro: true,
      }).success,
    ).toBe(false)
  })
})
