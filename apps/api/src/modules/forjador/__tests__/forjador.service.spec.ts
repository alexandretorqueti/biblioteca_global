import { describe, expect, it } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { parseForjadorResponse } from "../forjador.parser"

const resposta = [
  "<<<SOUL.md>>>", "Sou uma persona cuidadosa.", "<<<END SOUL.md>>>",
  "<<<IDENTITY.md>>>", "Nome: Forjador Global.", "<<<END IDENTITY.md>>>",
  "<<<AGENTS.md>>>", "- Responda com clareza.", "<<<END AGENTS.md>>>",
].join("\n")

describe("ForjadorService — parser da persona", () => {
  it("extrai os três arquivos pelos delimitadores inequívocos", () => {
    expect(parseForjadorResponse(resposta)).toEqual({
      soul: "Sou uma persona cuidadosa.",
      identity: "Nome: Forjador Global.",
      agents: "- Responda com clareza.",
    })
  })

  it("rejeita resposta sem qualquer um dos documentos", () => {
    expect(() => parseForjadorResponse("<<<SOUL.md>>>ok<<<END SOUL.md>>>"))
      .toThrow(BadRequestException)
  })
})
