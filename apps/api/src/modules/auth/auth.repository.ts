/**
 * Repositório de autenticação sobre o database core.
 * Services usam a interface (testável com fake); a implementação Drizzle
 * fica aqui — repositório é só SQL (PoC §6.1).
 */
import { Inject, Injectable } from "@nestjs/common"
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm"
import type {
  LoginIdentifierType,
  Perfil,
  ProjetoResumo,
  UsuarioAutenticado,
} from "@biblioteca-global/shared"
import {
  emailVerifications,
  projetos,
  projetosUsuarios,
  refreshTokens,
  usuarios,
} from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export type UsuarioRow = typeof usuarios.$inferSelect

export type EmailVerificationRow = typeof emailVerifications.$inferSelect

export interface RefreshTokenRow {
  id: number
  usuarioId: number
  expiresAt: Date
  revoked: boolean
}

export interface ResolvedScope {
  usuario: UsuarioAutenticado
  projeto: ProjetoResumo
}

export interface AuthRepository {
  findUsuarioByIdentifier(
    identifierType: LoginIdentifierType,
    identifier: string,
  ): Promise<UsuarioRow | undefined>
  findUsuarioById(id: number): Promise<UsuarioRow | undefined>
  listProjetosDoUsuario(usuarioId: number): Promise<ProjetoResumo[]>
  findProjetoAtivo(projetoId: number): Promise<
    { id: number; nome: string; slug: string } | undefined
  >
  findPerfilNoProjeto(
    usuarioId: number,
    projetoId: number,
  ): Promise<Perfil | undefined>
  /** Pivot + usuario.ativo revalidados de uma vez (PoC §5.2). */
  resolveScope(
    usuarioId: number,
    projetoId: number,
  ): Promise<ResolvedScope | undefined>
  createRefreshToken(row: {
    usuarioId: number
    tokenHash: string
    expiresAt: Date
  }): Promise<void>
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | undefined>
  revokeRefreshToken(id: number): Promise<void>
  updatePasswordHash(usuarioId: number, passwordHash: string): Promise<void>
  createEmailVerification(row: {
    email: string
    codeHash: string
    expiresAt: Date
  }): Promise<void>
  /** Linha mais recente, não usada e não expirada para o e-mail. */
  getActiveEmailVerification(
    email: string,
  ): Promise<EmailVerificationRow | undefined>
  incrementVerificationAttempts(id: number): Promise<void>
  markVerificationUsed(id: number): Promise<void>
}

export const AUTH_REPOSITORY = Symbol("AUTH_REPOSITORY")

/** identifierType do AuthPanel → coluna da tabela usuarios (PoC §4.2). */
const COLUNA_DO_IDENTIFIER: Record<
  LoginIdentifierType,
  "username" | "email" | "telefone" | "cpf"
> = {
  email: "email",
  username: "username",
  phone: "telefone",
  cpf: "cpf",
  document: "cpf",
}

export function toUsuarioAutenticado(
  row: UsuarioRow,
): UsuarioAutenticado {
  return {
    id: row.id,
    nome: row.nome,
    username: row.username,
    email: row.email,
    telefone: row.telefone,
    cpf: row.cpf,
  }
}

@Injectable()
export class DrizzleAuthRepository implements AuthRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async findUsuarioByIdentifier(
    identifierType: LoginIdentifierType,
    identifier: string,
  ): Promise<UsuarioRow | undefined> {
    const coluna = COLUNA_DO_IDENTIFIER[identifierType]
    const linhas = await this.db
      .select()
      .from(usuarios)
      .where(eq(usuarios[coluna], identifier))
      .limit(1)
    return linhas.at(0)
  }

  async findUsuarioById(id: number): Promise<UsuarioRow | undefined> {
    const linhas = await this.db
      .select()
      .from(usuarios)
      .where(eq(usuarios.id, id))
      .limit(1)
    return linhas.at(0)
  }

  async listProjetosDoUsuario(usuarioId: number): Promise<ProjetoResumo[]> {
    const linhas = await this.db
      .select({
        id: projetos.id,
        nome: projetos.nome,
        slug: projetos.slug,
        perfil: projetosUsuarios.perfil,
      })
      .from(projetosUsuarios)
      .innerJoin(projetos, eq(projetos.id, projetosUsuarios.projetoId))
      .where(
        and(
          eq(projetosUsuarios.usuarioId, usuarioId),
          eq(projetos.ativo, true),
        ),
      )
    return linhas
  }

  async findProjetoAtivo(
    projetoId: number,
  ): Promise<{ id: number; nome: string; slug: string } | undefined> {
    const linhas = await this.db
      .select({ id: projetos.id, nome: projetos.nome, slug: projetos.slug })
      .from(projetos)
      .where(and(eq(projetos.id, projetoId), eq(projetos.ativo, true)))
      .limit(1)
    return linhas.at(0)
  }

  async findPerfilNoProjeto(
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

  async resolveScope(
    usuarioId: number,
    projetoId: number,
  ): Promise<ResolvedScope | undefined> {
    const linhas = await this.db
      .select({
        usuarioId: usuarios.id,
        nome: usuarios.nome,
        username: usuarios.username,
        email: usuarios.email,
        telefone: usuarios.telefone,
        cpf: usuarios.cpf,
        projetoId: projetos.id,
        projetoNome: projetos.nome,
        projetoSlug: projetos.slug,
        perfil: projetosUsuarios.perfil,
      })
      .from(projetosUsuarios)
      .innerJoin(usuarios, eq(usuarios.id, projetosUsuarios.usuarioId))
      .innerJoin(projetos, eq(projetos.id, projetosUsuarios.projetoId))
      .where(
        and(
          eq(projetosUsuarios.usuarioId, usuarioId),
          eq(projetosUsuarios.projetoId, projetoId),
          eq(usuarios.ativo, true),
          eq(projetos.ativo, true),
        ),
      )
      .limit(1)

    const linha = linhas.at(0)
    if (!linha) return undefined
    return {
      usuario: {
        id: linha.usuarioId,
        nome: linha.nome,
        username: linha.username,
        email: linha.email,
        telefone: linha.telefone,
        cpf: linha.cpf,
      },
      projeto: {
        id: linha.projetoId,
        nome: linha.projetoNome,
        slug: linha.projetoSlug,
        perfil: linha.perfil,
      },
    }
  }

  async createRefreshToken(row: {
    usuarioId: number
    tokenHash: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(refreshTokens).values({
      usuarioId: row.usuarioId,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      revoked: false,
    })
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRow | undefined> {
    const linhas = await this.db
      .select({
        id: refreshTokens.id,
        usuarioId: refreshTokens.usuarioId,
        expiresAt: refreshTokens.expiresAt,
        revoked: refreshTokens.revoked,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1)
    return linhas.at(0)
  }

  async revokeRefreshToken(id: number): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.id, id))
  }

  async updatePasswordHash(
    usuarioId: number,
    passwordHash: string,
  ): Promise<void> {
    await this.db
      .update(usuarios)
      .set({ passwordHash })
      .where(eq(usuarios.id, usuarioId))
  }

  async createEmailVerification(row: {
    email: string
    codeHash: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(emailVerifications).values({
      email: row.email.toLowerCase(),
      codeHash: row.codeHash,
      expiresAt: row.expiresAt,
      attempts: 0,
    })
  }

  async getActiveEmailVerification(
    email: string,
  ): Promise<EmailVerificationRow | undefined> {
    const linhas = await this.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, email.toLowerCase()),
          isNull(emailVerifications.usedAt),
          gt(emailVerifications.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(emailVerifications.id))
      .limit(1)
    return linhas.at(0)
  }

  async incrementVerificationAttempts(id: number): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ attempts: sql`${emailVerifications.attempts} + 1` })
      .where(eq(emailVerifications.id, id))
  }

  async markVerificationUsed(id: number): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ usedAt: new Date() })
      .where(eq(emailVerifications.id, id))
  }
}
