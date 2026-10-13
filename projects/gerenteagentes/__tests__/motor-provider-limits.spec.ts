// @vitest-environment node
/**
 * Contrato de motor_provider_limits (migration 0087 + schema Drizzle):
 * provider varchar(100) UNIQUE (mesmo domínio de global_model_selection),
 * limites int unsigned NULLÍVEIS (NULL = sem restrição) e timestamps padrão
 * das tabelas de configuração do Motor.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { motorProviderLimits } from "../schema"

describe("motorProviderLimits — schema Drizzle", () => {
  const config = getTableConfig(motorProviderLimits)

  it("possui a coluna provider (varchar(100), obrigatória) com índice UNIQUE", () => {
    const col = config.columns.find((c) => c.name === "provider")

    expect(col).toBeDefined()
    expect(col!.dataType).toBe("string")
    const metadados = col as unknown as { length: number; notNull: boolean }
    expect(metadados.length).toBe(100)
    expect(metadados.notNull).toBe(true)

    const unique = config.indexes.find(
      (i) => (i as unknown as { config?: { name?: string; unique?: boolean } }).config?.name === "motor_provider_limits_provider_uq",
    )
    expect(unique).toBeDefined()
    expect((unique as unknown as { config: { unique: boolean } }).config.unique).toBe(true)
    const colunas = (unique as unknown as { config: { columns: Array<{ name?: string } | string> } }).config.columns
      .map((c) => (typeof c === "string" ? c : c.name))
    expect(colunas).toEqual(["provider"])
  })

  it.each([
    ["limite_execucao_total", "limiteExecucaoTotal"],
    ["limite_analises", "limiteAnalises"],
    ["limite_desenvolvimento", "limiteDesenvolvimento"],
  ])("possui a coluna %s (int unsigned, NULL = sem restrição)", (fisico, prop) => {
    const col = config.columns.find((c) => c.name === fisico)

    expect(col).toBeDefined()
    expect(col!.dataType).toBe("number")
    const metadados = col as unknown as { notNull: boolean; getSQLType(): string }
    expect(metadados.notNull).toBe(false)
    expect(metadados.getSQLType()).toBe("int unsigned")
    expect(motorProviderLimits[prop as keyof typeof motorProviderLimits]).toBeDefined()
  })

  it("possui created_at/updated_at como timestamps obrigatórios das tabelas de configuração", () => {
    for (const nome of ["created_at", "updated_at"]) {
      const col = config.columns.find((c) => c.name === nome)
      expect(col).toBeDefined()
      const metadados = col as unknown as { notNull: boolean; getSQLType(): string }
      expect(metadados.getSQLType()).toBe("timestamp")
      expect(metadados.notNull).toBe(true)
    }
  })
})

describe("migration 0087_motor_provider_limits", () => {
  const sql = readFileSync(new URL("../migrations/0087_motor_provider_limits.sql", import.meta.url), "utf8")

  it("cria a tabela de forma retomável (IF NOT EXISTS, sem breakpoint final)", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `motor_provider_limits`/)
    expect(sql.trimEnd()).not.toMatch(/--> statement-breakpoint$/)
  })

  it("declara as colunas físicas exatamente como o schema Drizzle", () => {
    expect(sql).toMatch(/`provider` varchar\(100\) NOT NULL/)
    expect(sql).toMatch(/`limite_execucao_total` int unsigned NULL/)
    expect(sql).toMatch(/`limite_analises` int unsigned NULL/)
    expect(sql).toMatch(/`limite_desenvolvimento` int unsigned NULL/)
    expect(sql).toMatch(/UNIQUE KEY `motor_provider_limits_provider_uq` \(`provider`\)/)
    expect(sql).toMatch(/`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP/)
    expect(sql).toMatch(/`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/)
  })
})
