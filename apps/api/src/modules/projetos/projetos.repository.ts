/**
 * Repositório de projetos sobre o database core (PoC §4.2/§6.2).
 */
import { Inject, Injectable } from "@nestjs/common"
import { eq, sql } from "drizzle-orm"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import { projetos } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export interface ProjetoRow {
  id: number
  nome: string
  slug: string
  ativo: boolean
  config: GeradorSistemaConfig
  branchTrabalho?: string | null
  repoPath?: string | null
  agenteId?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ProjetosRepository {
  listar(filtros: {
    page: number
    pageSize: number
  }): Promise<{ items: ProjetoRow[]; total: number }>
  findById(id: number): Promise<ProjetoRow | undefined>
  findBySlug(slug: string): Promise<ProjetoRow | undefined>
  criar(row: {
    nome: string
    slug: string
    ativo?: boolean
    config: GeradorSistemaConfig
    branchTrabalho?: string
    repoPath?: string
    agenteId?: string
  }): Promise<number>
  atualizar(
    id: number,
    campos: Partial<{
      nome: string
      ativo: boolean
      config: GeradorSistemaConfig
    }>,
  ): Promise<void>
  /** Exclusão física — usada apenas como compensação de provisionamento. */
  remover(id: number): Promise<void>
}

export const PROJETOS_REPOSITORY = Symbol("PROJETOS_REPOSITORY")

@Injectable()
export class DrizzleProjetosRepository implements ProjetosRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async listar(filtros: {
    page: number
    pageSize: number
  }): Promise<{ items: ProjetoRow[]; total: number }> {
    const total = await this.db
      .select({ quantidade: sql<number>`count(*)` })
      .from(projetos)

    const items = await this.db
      .select()
      .from(projetos)
      .orderBy(projetos.nome)
      .limit(filtros.pageSize)
      .offset((filtros.page - 1) * filtros.pageSize)

    return {
      items,
      total: Number(total.at(0)?.quantidade ?? 0),
    }
  }

  async findById(id: number): Promise<ProjetoRow | undefined> {
    const linhas = await this.db
      .select()
      .from(projetos)
      .where(eq(projetos.id, id))
      .limit(1)
    return linhas.at(0)
  }

  async findBySlug(slug: string): Promise<ProjetoRow | undefined> {
    const linhas = await this.db
      .select()
      .from(projetos)
      .where(eq(projetos.slug, slug))
      .limit(1)
    return linhas.at(0)
  }

  async criar(row: {
    nome: string
    slug: string
    ativo?: boolean
    config: GeradorSistemaConfig
    branchTrabalho?: string
    repoPath?: string
    agenteId?: string
  }): Promise<number> {
    const resultado = await this.db.insert(projetos).values({
      nome: row.nome,
      slug: row.slug,
      ativo: row.ativo ?? true,
      config: row.config,
      branchTrabalho: row.branchTrabalho,
      repoPath: row.repoPath,
      agenteId: row.agenteId,
    })
    return resultado[0].insertId
  }

  async atualizar(
    id: number,
    campos: Partial<{
      nome: string
      ativo: boolean
      config: GeradorSistemaConfig
    }>,
  ): Promise<void> {
    await this.db.update(projetos).set(campos).where(eq(projetos.id, id))
  }

  async remover(id: number): Promise<void> {
    await this.db.delete(projetos).where(eq(projetos.id, id))
  }
}
