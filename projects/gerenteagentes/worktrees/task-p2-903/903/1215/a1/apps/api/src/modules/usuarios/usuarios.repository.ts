/**
 * Repositório de usuários/vínculos sobre o database core.
 * Services usam a interface (testável com fake); Drizzle só SQL (PoC §6.1).
 */
import { Inject, Injectable } from "@nestjs/common"
import { and, eq, like, or, sql } from "drizzle-orm"
import type { Perfil } from "@biblioteca-global/shared"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import type { UsuarioRow } from "../auth/auth.repository"

export interface UsuarioListItem {
  id: number
  nome: string
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
  ativo: boolean
  perfil: Perfil
  createdAt: Date
  updatedAt: Date
}

export interface ListarUsuariosFiltros {
  search?: string
  page: number
  pageSize: number
}

export interface UsuariosRepository {
  listarDoProjeto(
    projetoId: number,
    filtros: ListarUsuariosFiltros,
  ): Promise<{ items: UsuarioListItem[]; total: number }>
  findById(id: number): Promise<UsuarioRow | undefined>
  findByEmail(email: string): Promise<UsuarioRow | undefined>
  findVinculo(usuarioId: number, projetoId: number): Promise<Perfil | undefined>
  criarUsuario(row: {
    nome: string
    username?: string
    email?: string
    telefone?: string
    cpf?: string
    /** null = conta provisionada sem senha (entra por código — auth única). */
    passwordHash: string | null
  }): Promise<number>
  criarVinculo(
    usuarioId: number,
    projetoId: number,
    perfil: Perfil,
  ): Promise<void>
  atualizarUsuario(
    id: number,
    campos: Partial<{
      nome: string
      username: string | null
      email: string | null
      telefone: string | null
      cpf: string | null
      ativo: boolean
      passwordHash: string
    }>,
  ): Promise<void>
  atualizarPerfilNoProjeto(
    usuarioId: number,
    projetoId: number,
    perfil: Perfil,
  ): Promise<void>
  removerVinculo(usuarioId: number, projetoId: number): Promise<void>
  removerTodosVinculos(usuarioId: number): Promise<void>
  findProjetoPorId(projetoId: number): Promise<
    { id: number; nome: string; slug: string; ativo: boolean } | undefined
  >
}

export const USUARIOS_REPOSITORY = Symbol("USUARIOS_REPOSITORY")

@Injectable()
export class DrizzleUsuariosRepository implements UsuariosRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async listarDoProjeto(
    projetoId: number,
    filtros: ListarUsuariosFiltros,
  ): Promise<{ items: UsuarioListItem[]; total: number }> {
    const busca = filtros.search?.trim()
    const onde = busca
      ? and(
          eq(projetosUsuarios.projetoId, projetoId),
          or(
            like(usuarios.nome, `%${busca}%`),
            like(usuarios.username, `%${busca}%`),
            like(usuarios.email, `%${busca}%`),
          ),
        )
      : eq(projetosUsuarios.projetoId, projetoId)

    const total = await this.db
      .select({ quantidade: sql<number>`count(*)` })
      .from(projetosUsuarios)
      .innerJoin(usuarios, eq(usuarios.id, projetosUsuarios.usuarioId))
      .where(onde)

    const linhas = await this.db
      .select({
        id: usuarios.id,
        nome: usuarios.nome,
        username: usuarios.username,
        email: usuarios.email,
        telefone: usuarios.telefone,
        cpf: usuarios.cpf,
        ativo: usuarios.ativo,
        perfil: projetosUsuarios.perfil,
        createdAt: usuarios.createdAt,
        updatedAt: usuarios.updatedAt,
      })
      .from(projetosUsuarios)
      .innerJoin(usuarios, eq(usuarios.id, projetosUsuarios.usuarioId))
      .where(onde)
      .orderBy(usuarios.nome)
      .limit(filtros.pageSize)
      .offset((filtros.page - 1) * filtros.pageSize)

    return {
      items: linhas,
      total: Number(total.at(0)?.quantidade ?? 0),
    }
  }

  async findById(id: number): Promise<UsuarioRow | undefined> {
    const linhas = await this.db
      .select()
      .from(usuarios)
      .where(eq(usuarios.id, id))
      .limit(1)
    return linhas.at(0)
  }

  async findByEmail(email: string): Promise<UsuarioRow | undefined> {
    const linhas = await this.db
      .select()
      .from(usuarios)
      .where(eq(usuarios.email, email))
      .limit(1)
    return linhas.at(0)
  }

  async findVinculo(
    usuarioId: number,
    projetoId: number,
  ): Promise<Perfil | undefined> {
    const linhas = await this.db
      .select({ perfil: projetosUsuarios.perfil })
      .from(projetosUsuarios)
      .where(
        and(
          eq(projetosUsuarios.usuarioId, usuarioId),
          eq(projetosUsuarios.projetoId, projetoId),
        ),
      )
      .limit(1)
    return linhas.at(0)?.perfil
  }

  async criarUsuario(row: {
    nome: string
    username?: string
    email?: string
    telefone?: string
    cpf?: string
    passwordHash: string | null
  }): Promise<number> {
    const resultado = await this.db.insert(usuarios).values({
      nome: row.nome,
      username: row.username ?? null,
      email: row.email ?? null,
      telefone: row.telefone ?? null,
      cpf: row.cpf ?? null,
      passwordHash: row.passwordHash,
      ativo: true,
    })
    return resultado[0].insertId
  }

  async criarVinculo(
    usuarioId: number,
    projetoId: number,
    perfil: Perfil,
  ): Promise<void> {
    await this.db
      .insert(projetosUsuarios)
      .values({ usuarioId, projetoId, perfil })
      .onDuplicateKeyUpdate({ set: { perfil } })
  }

  async atualizarUsuario(
    id: number,
    campos: Partial<{
      nome: string
      username: string | null
      email: string | null
      telefone: string | null
      cpf: string | null
      ativo: boolean
      passwordHash: string
    }>,
  ): Promise<void> {
    await this.db.update(usuarios).set(campos).where(eq(usuarios.id, id))
  }

  async atualizarPerfilNoProjeto(
    usuarioId: number,
    projetoId: number,
    perfil: Perfil,
  ): Promise<void> {
    await this.db
      .update(projetosUsuarios)
      .set({ perfil })
      .where(
        and(
          eq(projetosUsuarios.usuarioId, usuarioId),
          eq(projetosUsuarios.projetoId, projetoId),
        ),
      )
  }

  async removerVinculo(usuarioId: number, projetoId: number): Promise<void> {
    await this.db
      .delete(projetosUsuarios)
      .where(
        and(
          eq(projetosUsuarios.usuarioId, usuarioId),
          eq(projetosUsuarios.projetoId, projetoId),
        ),
      )
  }

  async removerTodosVinculos(usuarioId: number): Promise<void> {
    await this.db
      .delete(projetosUsuarios)
      .where(eq(projetosUsuarios.usuarioId, usuarioId))
  }

  async findProjetoPorId(
    projetoId: number,
  ): Promise<{ id: number; nome: string; slug: string; ativo: boolean } | undefined> {
    const linhas = await this.db
      .select({
        id: projetos.id,
        nome: projetos.nome,
        slug: projetos.slug,
        ativo: projetos.ativo,
      })
      .from(projetos)
      .where(eq(projetos.id, projetoId))
      .limit(1)
    return linhas.at(0)
  }
}
