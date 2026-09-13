import { describe, expect, it } from "vitest"
import {
  DEV_DESCRIPTION_MESSAGE_LIMIT,
  EMBEDDED_DESCRIPTION_LIMIT,
  resolveDeveloperDescription,
} from "../src/prompts/DeveloperTaskDescription.js"

describe("resolveDeveloperDescription", () => {
  it.each([
    [EMBEDDED_DESCRIPTION_LIMIT - 1, "abaixo do limite"],
    [EMBEDDED_DESCRIPTION_LIMIT, "no limite"],
  ])("embute descrição com %i caracteres (%s)", (length) => {
    const description = "x".repeat(length)
    expect(resolveDeveloperDescription(description)).toEqual({
      maskValue: description,
      contextBlocks: [],
      reference: null,
    })
  })

  it("usa referência e envia um bloco para descrição com 12.001 caracteres", () => {
    const description = "x".repeat(EMBEDDED_DESCRIPTION_LIMIT + 1)
    const result = resolveDeveloperDescription(description)

    expect(result.contextBlocks).toHaveLength(1)
    expect(result.contextBlocks.join("")).toBe(description)
    expect(result.reference).toBe(result.maskValue)
    expect(result.maskValue).toBe(
      "A descrição integral foi enviada em mensagem separada nesta sessão em 1 bloco(s). Use-a do início ao fim.",
    )
  })

  it("divide descrição longa em fatias de no máximo 30.000 caracteres sem perda", () => {
    const description = "a".repeat(DEV_DESCRIPTION_MESSAGE_LIMIT) + "b".repeat(123)
    const result = resolveDeveloperDescription(description)

    expect(result.contextBlocks).toHaveLength(2)
    expect(result.contextBlocks.every((block) => block.length <= DEV_DESCRIPTION_MESSAGE_LIMIT)).toBe(true)
    expect(result.contextBlocks.join("")).toBe(description)
    expect(result.maskValue).toContain("em 2 bloco(s)")
  })

  it.each([undefined, ""])("usa N/A quando a descrição está ausente ou vazia", (description) => {
    expect(resolveDeveloperDescription(description)).toEqual({
      maskValue: "N/A",
      contextBlocks: [],
      reference: null,
    })
  })

  it("não depende nem interpreta máscaras", () => {
    const description = "texto **DESCRICAOTAREFA** literal"
    expect(resolveDeveloperDescription(description).maskValue).toBe(description)
  })
})
