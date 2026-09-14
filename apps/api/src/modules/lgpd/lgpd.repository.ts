import { Inject, Injectable } from "@nestjs/common"
import { asc, eq } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { createHash } from "node:crypto"
import {
  consentimentos,
  logsAcessoDadosSensiveis,
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../database/schema"
import type {
  RetificacaoRequest,
  UsuarioDadosExport,
} from "@biblioteca-global/shared"
import { decryptCpf } from "../../common/crypto/cpf"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export interface LogAcessoDadosSensiveis {
  usuarioId: number
  tipoDado: string
  acao: string
  ip: string | null
}

export interface LogAcessoDadosSensiveisRow extends LogAcessoDadosSensiveis {
  id: number
  timestamp: Date
}

export interface LgpdRepository {
  exportarDados(usuarioId: number): Promise<UsuarioDadosExport | undefined>
  retificarDados(usuarioId: number, dados: RetificacaoRequest): Promise<void>
  anonimizarDados(usuarioId: number): Promise<void>
  registrarAcesso(log: LogAcessoDadosSensiveis): Promise<void>
  listarAcessos(limit: number): Promise<LogAcessoDadosSensiveisRow[]>
}

export const LGPD_REPOSITORY = Symbol("LGPD_REPOSITORY")

@Injectable()
export class DrizzleLgpdRepository implements LgpdRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async exportarDados(usuarioId: number): Promise<UsuarioDadosExport | undefined> {
    const usuario = (
      await this.db
        .select()
        .from(usuarios)
        .where(eq(usuarios.id, usuarioId))
        .limit(1)
    ).at(0)
    if (!usuario) return undefined

    const consentimentosUsuario = await this.db
      .select()
      .from(consentimentos)
      .where(eq(consentimentos.usuarioId, usuarioId))
      .orderBy(asc(consentimentos.data))
    const vinculos = await this.db
      .select({
        projetoId: projetos.id,
        projetoNome: projetos.nome,
        projetoSlug: projetos.slug,
        perfil: projetosUsuarios.perfil,
        createdAt: projetosUsuarios.createdAt,
      })
      .from(projetosUsuarios)
      .innerJoin(projetos, eq(projetos.id, projetosUsuarios.projetoId))
      .where(eq(projetosUsuarios.usuarioId, usuarioId))
      .orderBy(asc(projetosUsuarios.createdAt))

    return {
      id: usuario.id,
      username: usuario.username,
      email: usuario.email,
      telefone: usuario.telefone,
      cpf: this.cpfPortavel(usuario.cpf, usuario.cpfCriptografado),
      nome: usuario.nome,
      ativo: usuario.ativo,
      createdAt: usuario.createdAt.toISOString(),
      updatedAt: usuario.updatedAt.toISOString(),
      consentimentos: consentimentosUsuario.map((consentimento) => ({
        id: consentimento.id,
        usuario_id: consentimento.usuarioId,
        data: consentimento.data.toISOString(),
        versao_politica: consentimento.versaoPolitica,
        ip: consentimento.ip,
      })),
      vinculos: vinculos.map((vinculo) => ({
        projetoId: vinculo.projetoId,
        projetoNome: vinculo.projetoNome,
        projetoSlug: vinculo.projetoSlug,
        perfil: vinculo.perfil,
        createdAt: vinculo.createdAt.toISOString(),
      })),
    }
  }

  async retificarDados(
    usuarioId: number,
    dados: RetificacaoRequest,
  ): Promise<void> {
    await this.db.update(usuarios).set(dados).where(eq(usuarios.id, usuarioId))
  }

  async anonimizarDados(usuarioId: number): Promise<void> {
    const marcador = createHash("sha256")
      .update(`lgpd:${usuarioId}`)
      .digest("hex")
    await this.db
      .update(usuarios)
      .set({
        nome: "Usuário Excluído",
        email: `${marcador}@anon.invalid`,
        telefone: marcador.slice(0, 30),
        cpf: null,
        cpfCriptografado: marcador,
        ativo: false,
      })
      .where(eq(usuarios.id, usuarioId))
    await this.db
      .delete(projetosUsuarios)
      .where(eq(projetosUsuarios.usuarioId, usuarioId))
  }

  async registrarAcesso(log: LogAcessoDadosSensiveis): Promise<void> {
    await this.db.insert(logsAcessoDadosSensiveis).values({
      usuarioId: log.usuarioId,
      tipoDado: log.tipoDado,
      acao: log.acao,
      ip: log.ip,
    })
  }

  async listarAcessos(limit: number): Promise<LogAcessoDadosSensiveisRow[]> {
    return this.db
      .select({
        id: logsAcessoDadosSensiveis.id,
        usuarioId: logsAcessoDadosSensiveis.usuarioId,
        tipoDado: logsAcessoDadosSensiveis.tipoDado,
        acao: logsAcessoDadosSensiveis.acao,
        timestamp: logsAcessoDadosSensiveis.timestamp,
        ip: logsAcessoDadosSensiveis.ip,
      })
      .from(logsAcessoDadosSensiveis)
      .orderBy(desc(logsAcessoDadosSensiveis.timestamp))
      .limit(limit)
  }

  private cpfPortavel(cpf: string | null, cpfCriptografado: string | null): string | null {
    if (cpf) return cpf
    if (!cpfCriptografado) return null
    try {
      return decryptCpf(cpfCriptografado)
    } catch {
      return null
    }
  }
}
