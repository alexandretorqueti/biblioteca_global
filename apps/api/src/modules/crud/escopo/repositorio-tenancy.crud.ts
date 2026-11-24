/**
 * RepositorioTenancyProjectDb — implementação do contrato de tenancy
 * (projects/gestao-de-tarefas-global/src/tenancy/tipos.ts) contra o banco do
 * projeto (projeto_<id>) via ProjectDbFactory + core (resolução slug → id).
 *
 * Registrada em crud.module no token REPOSITORIO_TENANCY para o
 * EscopoOrganizacaoGuard (subtarefa 1). O id do projeto é resolvido uma vez
 * no core (`projetos.slug`) e mantido em cache — o slug é fixo por instância
 * (a chain do CRUD só aciona o guard para `gestao-de-tarefas-global`).
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common"
import { eq } from "drizzle-orm"
import { colaboradores } from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type {
  LinhaColaboradorPorUsuario,
  RepositorioTenancy,
} from "../../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { projetos } from "../../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../project-db.factory"

@Injectable()
export class RepositorioTenancyProjectDb implements RepositorioTenancy {
  private projetoIdCache: number | null = null

  // @Inject explícito: DI funcional sem emitDecoratorMetadata (tsx/esbuild).
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    private readonly slug: string,
  ) {}

  async listarColaboradoresPorUsuario(
    usuarioId: number,
  ): Promise<LinhaColaboradorPorUsuario[]> {
    const projetoId = await this.resolverProjetoId()
    const db = await this.factory.obter({ id: projetoId })
    const linhas = await db
      .select({
        id: colaboradores.id,
        organizacaoId: colaboradores.organizacaoId,
        ativo: colaboradores.ativo,
        usuarioId: colaboradores.usuarioId,
      })
      .from(colaboradores)
      .where(eq(colaboradores.usuarioId, usuarioId))
    return linhas.map((linha) => ({
      id: Number(linha.id),
      organizacaoId: Number(linha.organizacaoId),
      ativo: Boolean(linha.ativo),
      usuarioId: linha.usuarioId == null ? null : Number(linha.usuarioId),
    }))
  }

  /** Resolve (e cacheia) o id do projeto no core pelo slug fixo da instância. */
  private async resolverProjetoId(): Promise<number> {
    if (this.projetoIdCache !== null) return this.projetoIdCache
    const linha = (
      await this.coreDb
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, this.slug))
        .limit(1)
    ).at(0)
    if (!linha) {
      throw new NotFoundException(
        `Projeto "${this.slug}" não provisionado no core — tenancy indisponível.`,
      )
    }
    this.projetoIdCache = Number(linha.id)
    return this.projetoIdCache
  }
}
