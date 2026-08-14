/**
 * Validação da config contra o schema do projeto (defesa em profundidade —
 * PoC §7.4): referenciou resource ou campo que não existe na tabela → erro.
 */
import { getTableColumns } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

/**
 * Resources do core atendidos por módulos específicos (não pelo CRUD
 * genérico) — legítimos na config do projeto biblioteca-global.
 */
export const RESOURCES_DO_CORE: ReadonlySet<string> = new Set([
  "usuarios",
  "projetos",
])

export class ConfigInvalidaError extends Error {
  constructor(readonly problemas: string[]) {
    super(`Config inválida contra o schema do projeto: ${problemas.join("; ")}`)
    this.name = "ConfigInvalidaError"
  }
}

export function validarConfigContraSchema(
  config: GeradorSistemaConfig,
  tabelas: Record<string, MySqlTable>,
): void {
  const problemas: string[] = []

  for (const grupo of config.groups) {
    for (const item of grupo.items) {
      const tela = item.screen
      if (tela.kind !== "cadastro") continue

      const resource = tela.resource
      const tabela = tabelas[resource]
      if (!tabela) {
        if (!RESOURCES_DO_CORE.has(resource)) {
          problemas.push(
            `item "${item.id}": resource "${resource}" não existe no schema do projeto`,
          )
        }
        continue
      }

      const colunas = new Set(Object.keys(getTableColumns(tabela)))
      for (const field of tela.fields ?? []) {
        if (!colunas.has(field.name)) {
          problemas.push(
            `item "${item.id}": field "${field.name}" não existe na tabela "${resource}"`,
          )
        }
      }
      for (const field of tela.overrides?.fields ?? []) {
        if (!colunas.has(field.name)) {
          problemas.push(
            `item "${item.id}": override de field "${field.name}" não existe na tabela "${resource}"`,
          )
        }
      }
      for (const colunaOcultada of tela.overrides?.hiddenColumns ?? []) {
        if (!colunas.has(colunaOcultada)) {
          problemas.push(
            `item "${item.id}": hiddenColumn "${colunaOcultada}" não existe na tabela "${resource}"`,
          )
        }
      }
    }
  }

  if (problemas.length > 0) {
    throw new ConfigInvalidaError(problemas)
  }
}
