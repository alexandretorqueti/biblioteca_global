/**
 * Registro de schemas por projeto — whitelist de resources do CRUD genérico
 * (PoC §6.2: resource = nome de tabela no schema.ts do projeto, nunca
 * string arbitrária).
 *
 * DynamicSchemaRegistry: carrega projects/SLUG/schema.ts automaticamente no boot
 * da API. Erros de carregamento são logados por projeto sem derrubar o boot.
 * Projetos existentes (biblioteca-global, documentacao, gerenteagentes,
 * sistema-adm-global, taqui) continuam funcionando sem mudanças de código.
 */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { readdir, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { coletarTabelas } from "@biblioteca-global/schema-tools"

export interface SchemaRegistry {
  /** Tabelas do projeto por nome; undefined = projeto sem schema. */
  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined
  /** Lista de slugs de projetos carregados com sucesso. */
  projetosCarregados(): string[]
}

export const SCHEMA_REGISTRY = Symbol("SCHEMA_REGISTRY")

@Injectable()
export class DynamicSchemaRegistry implements SchemaRegistry, OnModuleInit {
  private readonly logger = new Logger(DynamicSchemaRegistry.name)
  private readonly porSlug = new Map<string, Record<string, MySqlTable>>()
  // Usa process.cwd() para ser robusto em diferentes ambientes (dev, teste, produção).
  // O vitest roda com cwd na raiz do repo; o NestJS em produção roda com cwd em apps/api.
  // Se cwd for apps/api, sobe dois níveis para chegar à raiz do repo.
  private readonly projetosDir = process.cwd().endsWith('/apps/api')
    ? resolve(process.cwd(), '..', '..', 'projects')
    : resolve(process.cwd(), 'projects')

  async onModuleInit(): Promise<void> {
    await this.carregarProjetos()
  }

  /**
   * Escaneia projects/SLUG/schema.ts e carrega cada módulo dinamicamente.
   * Erros de carregamento são logados por projeto sem derrubar o boot.
   */
  private async carregarProjetos(): Promise<void> {
    let slugs: string[]
    console.log(`[DynamicSchemaRegistry] Tentando ler diretório de projetos: ${this.projetosDir}`)
    try {
      const entries = await readdir(this.projetosDir, { withFileTypes: true })
      slugs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      console.log(`[DynamicSchemaRegistry] Projetos encontrados no diretório: ${slugs.join(", ")}`)
    } catch (erro: unknown) {
      console.error(
        `[DynamicSchemaRegistry] Falha ao ler diretório de projetos: ${erro instanceof Error ? erro.message : String(erro)}`,
      )
      return
    }

    for (const slug of slugs) {
      try {
        const schemaPath = join(this.projetosDir, slug, "schema.ts")
        // Verifica se o arquivo existe antes de tentar importar
        try {
          await access(schemaPath)
        } catch {
          // Projeto sem schema.ts — ignora silenciosamente
          console.log(`[DynamicSchemaRegistry] Projeto "${slug}" sem schema.ts — ignorado`)
          continue
        }

        // Import dinâmico do schema do projeto
        // Caminho absoluta para funcionar tanto em dev quanto em produção
        console.log(`[DynamicSchemaRegistry] Importando schema de "${slug}": ${schemaPath}`)
        const modulo = await import(schemaPath)
        const tabelas = coletarTabelas(modulo)
        this.porSlug.set(slug, tabelas)
        console.log(
          `[DynamicSchemaRegistry] Projeto "${slug}" carregado: ${Object.keys(tabelas).length} tabela(s) — ${Object.keys(tabelas).join(", ")}`,
        )
      } catch (erro: unknown) {
        // Erro de carregamento logado por projeto sem derrubar o boot
        console.error(
          `[DynamicSchemaRegistry] Falha ao carregar schema do projeto "${slug}": ${erro instanceof Error ? erro.message : String(erro)}`,
        )
      }
    }

    console.log(
      `[DynamicSchemaRegistry] Inicializado: ${this.porSlug.size} projeto(s) carregado(s) — slugs: ${Array.from(this.porSlug.keys()).join(", ")}`,
    )
  }

  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined {
    return this.porSlug.get(slug)
  }

  projetosCarregados(): string[] {
    return Array.from(this.porSlug.keys())
  }
}

/**
 * StaticSchemaRegistry — mantido para compatibilidade com testes que mockam
 * o registry. Em produção, use DynamicSchemaRegistry.
 */
@Injectable()
export class StaticSchemaRegistry implements SchemaRegistry {
  private readonly porSlug = new Map<string, Record<string, MySqlTable>>()

  constructor(tabelasPorSlug: Record<string, Record<string, MySqlTable>> = {}) {
    for (const [slug, tabelas] of Object.entries(tabelasPorSlug)) {
      this.porSlug.set(slug, tabelas)
    }
  }

  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined {
    return this.porSlug.get(slug)
  }

  projetosCarregados(): string[] {
    return Array.from(this.porSlug.keys())
  }
}
