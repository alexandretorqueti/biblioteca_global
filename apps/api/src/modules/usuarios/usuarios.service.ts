/**
 * UsuariosService — CRUD de usuários com escopo por projeto (PoC §6.2/§8).
 * Regras:
 * - O vínculo vem do TOKEN: criar usuário vincula ao projeto da sessão.
 * - `projetoId` jamais é aceito do cliente (o pipe rejeita campo extra).
 * - Admin global (projeto biblioteca-global): vê qualquer projeto, gerencia
 *   vínculos e desativa usuários (nunca apaga fisicamente).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import argon2 from "argon2"
import type { PaginatedResult, Perfil } from "@biblioteca-global/shared"
import { SLUG_ADMIN_GLOBAL } from "../../common/guards/global-admin.guard"
import type { ProjectScope } from "../../common/types"
import type { CreateUsuarioDto } from "./dto/create-usuario.dto"
import type { ListUsuariosQueryDto } from "./dto/list-usuarios-query.dto"
import type { UpdateUsuarioDto } from "./dto/update-usuario.dto"
import type { VincularDto } from "./dto/vincular.dto"
import {
  USUARIOS_REPOSITORY,
  type UsuarioListItem,
  type UsuariosRepository,
} from "./usuarios.repository"
import type { UsuarioRow } from "../auth/auth.repository"

export interface UsuarioPublico {
  id: number
  nome: string
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
  ativo: boolean
  createdAt: Date
  updatedAt: Date
}

export interface UsuarioDetalhe extends UsuarioPublico {
  perfilNoProjeto: Perfil | null
}

function ehAdminGlobal(scope: ProjectScope): boolean {
  return scope.projeto.slug === SLUG_ADMIN_GLOBAL
}

function semHash(linha: UsuarioRow): UsuarioPublico {
  return {
    id: linha.id,
    nome: linha.nome,
    username: linha.username ?? null,
    email: linha.email ?? null,
    telefone: linha.telefone ?? null,
    cpf: linha.cpf ?? null,
    ativo: linha.ativo,
    createdAt: linha.createdAt,
    updatedAt: linha.updatedAt,
  }
}

function ehErroDuplicado(erro: unknown): boolean {
  const codigos = (erro as { code?: string; cause?: { code?: string } })
  return codigos.code === "ER_DUP_ENTRY" || codigos.cause?.code === "ER_DUP_ENTRY"
}

@Injectable()
export class UsuariosService {
  constructor(
    @Inject(USUARIOS_REPOSITORY) private readonly repo: UsuariosRepository,
  ) {}

  async listar(
    scope: ProjectScope,
    query: ListUsuariosQueryDto,
  ): Promise<PaginatedResult<UsuarioListItem>> {
    let projetoAlvo = scope.projeto.id
    if (query.projetoId !== undefined) {
      if (!ehAdminGlobal(scope)) {
        throw new ForbiddenException(
          "Filtro por projeto é exclusivo do admin global",
        )
      }
      const projeto = await this.repo.findProjetoPorId(query.projetoId)
      if (!projeto) {
        throw new NotFoundException("Projeto não encontrado")
      }
      projetoAlvo = projeto.id
    }

    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20
    const resultado = await this.repo.listarDoProjeto(projetoAlvo, {
      search: query.search,
      page,
      pageSize,
    })
    return { ...resultado, page, pageSize }
  }

  async detalhar(
    scope: ProjectScope,
    usuarioId: number,
  ): Promise<UsuarioDetalhe> {
    const usuario = await this.repo.findById(usuarioId)
    if (!usuario) {
      throw new NotFoundException("Usuário não encontrado")
    }

    if (ehAdminGlobal(scope)) {
      const perfil = await this.repo.findVinculo(usuarioId, scope.projeto.id)
      return { ...semHash(usuario), perfilNoProjeto: perfil ?? null }
    }

    const perfil = await this.repo.findVinculo(usuarioId, scope.projeto.id)
    if (!perfil) {
      throw new NotFoundException("Usuário não pertence ao projeto")
    }
    return { ...semHash(usuario), perfilNoProjeto: perfil }
  }

  async criar(
    scope: ProjectScope,
    dto: CreateUsuarioDto,
  ): Promise<UsuarioPublico & { perfil: Perfil }> {
    const temIdentificador =
      dto.username || dto.email || dto.telefone || dto.cpf
    if (!temIdentificador) {
      throw new BadRequestException(
        "Informe ao menos um identificador (username, email, telefone ou cpf)",
      )
    }

    const perfil: Perfil = dto.perfil ?? "operador"
    const passwordHash = await argon2.hash(dto.senhaInicial, {
      type: argon2.argon2id,
    })

    let usuarioId: number
    try {
      usuarioId = await this.repo.criarUsuario({
        nome: dto.nome,
        username: dto.username,
        email: dto.email,
        telefone: dto.telefone,
        cpf: dto.cpf,
        passwordHash,
      })
    } catch (erro: unknown) {
      if (ehErroDuplicado(erro)) {
        throw new ConflictException("Identificador já cadastrado")
      }
      throw erro
    }

    // O vínculo é sempre com o projeto do token — nunca vem do body.
    await this.repo.criarVinculo(usuarioId, scope.projeto.id, perfil)
    if (dto.ativo === false) {
      await this.repo.atualizarUsuario(usuarioId, { ativo: false })
    }

    const usuario = await this.repo.findById(usuarioId)
    if (!usuario) {
      throw new Error("usuário não encontrado após a criação")
    }
    return { ...semHash(usuario), perfil }
  }

  async editar(
    scope: ProjectScope,
    usuarioId: number,
    dto: UpdateUsuarioDto,
  ): Promise<UsuarioDetalhe> {
    const usuario = await this.repo.findById(usuarioId)
    if (!usuario) {
      throw new NotFoundException("Usuário não encontrado")
    }

    const perfilAtual = await this.repo.findVinculo(
      usuarioId,
      scope.projeto.id,
    )
    if (!perfilAtual && !ehAdminGlobal(scope)) {
      throw new NotFoundException("Usuário não pertence ao projeto")
    }

    const campos: Partial<{
      nome: string
      username: string | null
      email: string | null
      telefone: string | null
      cpf: string | null
      ativo: boolean
    }> = {}
    if (dto.nome !== undefined) campos.nome = dto.nome
    if (dto.username !== undefined) campos.username = dto.username
    if (dto.email !== undefined) campos.email = dto.email
    if (dto.telefone !== undefined) campos.telefone = dto.telefone
    if (dto.cpf !== undefined) campos.cpf = dto.cpf
    if (dto.ativo !== undefined) campos.ativo = dto.ativo

    try {
      if (Object.keys(campos).length > 0) {
        await this.repo.atualizarUsuario(usuarioId, campos)
      }
      // perfil vale para o projeto da sessão, quando o usuário pertence a ele.
      if (dto.perfil !== undefined && perfilAtual) {
        await this.repo.atualizarPerfilNoProjeto(
          usuarioId,
          scope.projeto.id,
          dto.perfil,
        )
      }
    } catch (erro: unknown) {
      if (ehErroDuplicado(erro)) {
        throw new ConflictException("Identificador já cadastrado")
      }
      throw erro
    }

    return this.detalhar(scope, usuarioId)
  }

  /**
   * Projeto comum: desvincula do projeto da sessão (usuário global fica).
   * Admin global: desativa (ativo=false) + remove todos os vínculos —
   * nunca apaga fisicamente (decisão 2026-08-14).
   */
  async excluir(scope: ProjectScope, usuarioId: number): Promise<void> {
    const usuario = await this.repo.findById(usuarioId)
    if (!usuario) {
      throw new NotFoundException("Usuário não encontrado")
    }

    if (ehAdminGlobal(scope)) {
      if (scope.projeto.perfil !== "admin") {
        throw new ForbiddenException(
          "Somente admin desativa usuários em modo global",
        )
      }
      await this.repo.removerTodosVinculos(usuarioId)
      await this.repo.atualizarUsuario(usuarioId, { ativo: false })
      return
    }

    const perfil = await this.repo.findVinculo(usuarioId, scope.projeto.id)
    if (!perfil) {
      throw new NotFoundException("Usuário não pertence ao projeto")
    }
    await this.repo.removerVinculo(usuarioId, scope.projeto.id)
  }

  /** Exclusivo do admin global — gerencia vínculos em qualquer projeto. */
  async vincular(
    scope: ProjectScope,
    usuarioId: number,
    dto: VincularDto,
  ): Promise<{ usuarioId: number }> {
    const usuario = await this.repo.findById(usuarioId)
    if (!usuario) {
      throw new NotFoundException("Usuário não encontrado")
    }
    const temOperacao =
      (dto.adicionar?.length ?? 0) > 0 || (dto.remover?.length ?? 0) > 0
    if (!temOperacao) {
      throw new BadRequestException(
        "Informe ao menos uma operação em adicionar ou remover",
      )
    }

    for (const vinculo of dto.adicionar ?? []) {
      const projeto = await this.repo.findProjetoPorId(vinculo.projetoId)
      if (!projeto || !projeto.ativo) {
        throw new NotFoundException(
          `Projeto ${vinculo.projetoId} não encontrado ou inativo`,
        )
      }
      await this.repo.criarVinculo(usuarioId, projeto.id, vinculo.perfil)
    }
    for (const projetoId of dto.remover ?? []) {
      await this.repo.removerVinculo(usuarioId, projetoId)
    }
    return { usuarioId }
  }
}
