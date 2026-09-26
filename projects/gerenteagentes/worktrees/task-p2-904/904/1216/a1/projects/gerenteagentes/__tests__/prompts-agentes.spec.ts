import { describe, expect, it } from "vitest"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { promptsAgentes } from "../schema"
import { PROMPTS_AGENTES_SEED } from "../seed-prompts"
import { AGENT_PROMPT_CATALOG } from "../motor-v2/src/prompts/prompt-catalog"

describe("prompts_agentes", () => {
  it("possui tipo, situação e conteúdo persistidos", () => {
    const columns = getTableConfig(promptsAgentes).columns
    for (const name of ["tipo_agente", "situacao", "conteudo"]) {
      const column = columns.find((candidate) => candidate.name === name)
      expect(column).toBeDefined()
      expect((column as unknown as { notNull: boolean }).notNull).toBe(true)
    }
  })

  it("contém um registro de seed para cada situação mapeada", () => {
    expect(PROMPTS_AGENTES_SEED).toHaveLength(AGENT_PROMPT_CATALOG.length)
    expect(PROMPTS_AGENTES_SEED.map((entry) => entry.chave)).toEqual(
      AGENT_PROMPT_CATALOG.map((entry) => entry.key),
    )
  })

  it("mantém os registros identificáveis e com marcadores", () => {
    for (const entry of PROMPTS_AGENTES_SEED) {
      expect(entry.tipoAgente).toBeTruthy()
      expect(entry.situacao).toBeTruthy()
      expect(entry.conteudo).toBeTruthy()
      expect(entry.origem).toMatch(/#[A-Za-z]/)
      expect(entry.marcadores.length).toBeGreaterThan(0)
    }
  })
})
