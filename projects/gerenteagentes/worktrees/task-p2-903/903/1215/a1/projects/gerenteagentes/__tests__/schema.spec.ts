// @vitest-environment node
/**
 * Contrato do schema Drizzle de projeto_motor_config — valida a presença e o nome
 * físico das colunas repo_path, branch_trabalho, build_command, unit_test_command.
 *
 * Teste versionado sob Vitest: ao atualizar o schema, esta suíte garante que os
 * campos obrigatórios sobrevivam a re-generações de migration sem desaparecer.
 *
 * NOTA (2026-09-03): repo_path e branch_trabalho foram movidos de projetos_captados
 * para projeto_motor_config (configuração operacional do Motor-v2).
 */
import { describe, expect, it } from "vitest"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { projetoMotorConfig, annotations } from "../schema"

describe("projetoMotorConfig — schema Drizzle", () => {
  it("possui a coluna repo_path (varchar(500), obrigatória)", () => {
    const config = getTableConfig(projetoMotorConfig)
    const col = config.columns.find((c) => c.name === "repo_path")

    expect(col).toBeDefined()
    expect(col!.dataType).toBe("string")
    const metadados = col as unknown as { length: number; notNull: boolean }
    expect(metadados.length).toBe(500)
    expect(metadados.notNull).toBe(true)
    expect(projetoMotorConfig.repoPath).toBeDefined()
  })

  it("possui a coluna branch_trabalho (varchar(255), obrigatória)", () => {
    const config = getTableConfig(projetoMotorConfig)
    const col = config.columns.find((c) => c.name === "branch_trabalho")

    expect(col).toBeDefined()
    expect(col!.name).toBe("branch_trabalho")
    expect(col!.dataType).toBe("string")
    const metadados = col as unknown as { length: number; notNull: boolean }
    expect(metadados.length).toBe(255)
    expect(metadados.notNull).toBe(true)
  })

  it("possui a coluna build_command (varchar(500), obrigatória)", () => {
    const config = getTableConfig(projetoMotorConfig)
    const col = config.columns.find((c) => c.name === "build_command")

    expect(col).toBeDefined()
    expect(col!.dataType).toBe("string")
    const metadados = col as unknown as { length: number; notNull: boolean }
    expect(metadados.length).toBe(500)
    expect(metadados.notNull).toBe(true)
  })

  it("possui a coluna unit_test_command (varchar(500), obrigatória)", () => {
    const config = getTableConfig(projetoMotorConfig)
    const col = config.columns.find((c) => c.name === "unit_test_command")

    expect(col).toBeDefined()
    expect(col!.dataType).toBe("string")
    const metadados = col as unknown as { length: number; notNull: boolean }
    expect(metadados.length).toBe(500)
    expect(metadados.notNull).toBe(true)
  })

  it("expõe branchTrabalho na tabela Drizzle (prop TS)", () => {
    expect((projetoMotorConfig as any).branchTrabalho).toBeDefined()
  })
})

describe("annotations — projeto_motor_config", () => {
  it("inclui branch_trabalho nas anotações", () => {
    const ann = annotations.projeto_motor_config
    expect(ann.branch_trabalho).toBeDefined()
    expect(ann.branch_trabalho.label).toBe("Branch de trabalho")
    expect(ann.branch_trabalho.maxLength).toBe(255)
  })

  it("inclui repo_path nas anotações", () => {
    const ann = annotations.projeto_motor_config
    expect(ann.repo_path).toMatchObject({ label: "Caminho do repositório", maxLength: 500 })
  })

  it("inclui build_command nas anotações", () => {
    const ann = annotations.projeto_motor_config
    expect(ann.build_command).toMatchObject({ label: "Comando de build", maxLength: 500 })
  })

  it("inclui unit_test_command nas anotações", () => {
    const ann = annotations.projeto_motor_config
    expect(ann.unit_test_command).toMatchObject({ label: "Comando de testes", maxLength: 500 })
  })
})
