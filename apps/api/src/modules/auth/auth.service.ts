/**
 * AuthService — regras de negócio da autenticação (PoC §5).
 * - Login por identificador configurável (argon2id, checagem de ativo).
 * - Refresh token opaco persistido (revogável) + rotação no /refresh.
 * - Access token JWT curto com claims { sub, projetoId, perfil }.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common"
import { JwtService, type JwtSignOptions } from "@nestjs/jwt"
import { randomBytes, createHash } from "node:crypto"
import argon2 from "argon2"
import type {
  LoginResponse,
  MeResponse,
  Perfil,
  RefreshResponse,
  SelectProjectResponse,
} from "@biblioteca-global/shared"
import { EnvService } from "../../config/env.service"
import type { ProjectScope } from "../../common/types"
import {
  AUTH_REPOSITORY,
  toUsuarioAutenticado,
  type AuthRepository,
} from "./auth.repository"
import type { LoginDto } from "./dto/login.dto"
import type { SelectProjectDto } from "./dto/select-project.dto"
import type { ChangePasswordDto } from "./dto/change-password.dto"

const CREDENCIAIS_INVALIDAS = "Credenciais inválidas"

export interface AccessTokenClaims {
  sub: number
  projetoId: number
  perfil: Perfil
}

@Injectable()
export class AuthService {
  // @Inject explícito em tudo: DI não depende de emitDecoratorMetadata
  // (tsx/esbuild não emite design:paramtypes).
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponse> {
    const usuario = await this.repo.findUsuarioByIdentifier(
      dto.identifierType,
      dto.identifier,
    )
    // Mensagem única para usuário inexistente/inativo/senha errada —
    // não revela qual conta existe.
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS)
    }
    const senhaOk = await argon2.verify(usuario.passwordHash, dto.password)
    if (!senhaOk) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS)
    }

    const refreshToken = await this.issueRefreshToken(usuario.id)
    const projetos = await this.repo.listProjetosDoUsuario(usuario.id)
    return {
      refreshToken,
      usuario: toUsuarioAutenticado(usuario),
      projetos,
    }
  }

  async selectProject(
    usuarioId: number,
    dto: SelectProjectDto,
  ): Promise<SelectProjectResponse> {
    const projeto = await this.repo.findProjetoAtivo(dto.projetoId)
    if (!projeto) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const perfil = await this.repo.findPerfilNoProjeto(usuarioId, projeto.id)
    if (!perfil) {
      throw new ForbiddenException("Usuário não pertence ao projeto")
    }
    const accessToken = await this.signAccessToken({
      sub: usuarioId,
      projetoId: projeto.id,
      perfil,
    })
    return {
      accessToken,
      projeto: { ...projeto, perfil },
    }
  }

  /** Rotaciona: revoga o refresh apresentado e emite um novo. */
  async refresh(token: string): Promise<RefreshResponse> {
    const sessao = await this.validateRefreshToken(token)
    await this.repo.revokeRefreshToken(sessao.tokenId)
    const refreshToken = await this.issueRefreshToken(sessao.usuarioId)
    const projetos = await this.repo.listProjetosDoUsuario(sessao.usuarioId)
    return { refreshToken, projetos }
  }

  async logout(token: string): Promise<void> {
    const sessao = await this.validateRefreshToken(token)
    await this.repo.revokeRefreshToken(sessao.tokenId)
  }

  async changePassword(
    usuarioId: number,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const usuario = await this.repo.findUsuarioById(usuarioId)
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException(CREDENCIAIS_INVALIDAS)
    }
    const senhaAtualOk = await argon2.verify(
      usuario.passwordHash,
      dto.senhaAtual,
    )
    if (!senhaAtualOk) {
      throw new BadRequestException("Senha atual incorreta")
    }
    const novoHash = await argon2.hash(dto.novaSenha, {
      type: argon2.argon2id,
    })
    await this.repo.updatePasswordHash(usuarioId, novoHash)
  }

  me(scope: ProjectScope): MeResponse {
    return {
      usuario: scope.usuario,
      projeto: scope.projeto,
      perfil: scope.projeto.perfil,
    }
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    const expiresIn = this.env.jwtAccessTtl as JwtSignOptions["expiresIn"]
    return this.jwt.signAsync(
      { sub: claims.sub, projetoId: claims.projetoId, perfil: claims.perfil },
      { expiresIn },
    )
  }

  async issueRefreshToken(usuarioId: number): Promise<string> {
    const token = randomBytes(48).toString("base64url")
    const tokenHash = createHash("sha256").update(token).digest("hex")
    const ttlMs = this.env.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    await this.repo.createRefreshToken({
      usuarioId,
      tokenHash,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    return token
  }

  async validateRefreshToken(
    token: string,
  ): Promise<{ tokenId: number; usuarioId: number }> {
    const tokenHash = createHash("sha256").update(token).digest("hex")
    const linha = await this.repo.findRefreshTokenByHash(tokenHash)
    if (!linha || linha.revoked || linha.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Refresh token inválido ou expirado")
    }
    const usuario = await this.repo.findUsuarioById(linha.usuarioId)
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException("Usuário não encontrado ou inativo")
    }
    return { tokenId: linha.id, usuarioId: linha.usuarioId }
  }
}
