/**
 * Registro de schemas por projeto — whitelist de resources do CRUD genérico
 * (PoC §6.2: resource = nome de tabela no schema.ts do projeto, nunca
 * string arbitrária). As tabelas são coletadas dos módulos de schema das
 * pastas projects/<slug>/ (Etapa 6).
 */
import { Injectable } from "@nestjs/common"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { coletarTabelas } from "@biblioteca-global/schema-tools"
import * as bibliotecaGlobalSchema from "../../../../../projects/biblioteca-global/schema"
import * as documentacaoSchema from "../../../../../projects/documentacao/schema"
import * as gerenteagentesSchema from "../../../../../projects/gerenteagentes/schema"

export interface SchemaRegistry {
  /** Tabelas do projeto por nome; undefined = projeto sem schema. */
  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined
}

export const SCHEMA_REGISTRY = Symbol("SCHEMA_REGISTRY")

@Injectable()
export class StaticSchemaRegistry implements SchemaRegistry {
  private readonly porSlug = new Map<string, Record<string, MySqlTable>>([
    // Projeto de administração da plataforma — sem tabelas de negócio
    // (PoC §9.1): os resources daqui são os módulos específicos do core.
    ["biblioteca-global", coletarTabelas(bibliotecaGlobalSchema)],
    ["documentacao", coletarTabelas(documentacaoSchema)],
    ["gerenteagentes", coletarTabelas(gerenteagentesSchema)],
  ])

  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined {
    return this.porSlug.get(slug)
  }
}
