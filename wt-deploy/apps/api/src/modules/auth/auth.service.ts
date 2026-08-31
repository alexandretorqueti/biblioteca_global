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
  RequestCodeResponse,
  SelectProjectResponse,
  SetPasswordResponse,
  VerifyCodeResponse,
} from "@biblioteca-global/shared"
import { EnvService } from "../../config/env.service"
import type { ProjectScope } from "../../common/types"
import {
  AUTH_REPOSITORY,
  toUsuarioAutenticado,
  type AuthRepository,
} from "./auth.repository"
import { EmailService } from "./email.service"
import {
  generateCode,
  hashCode,
  isValidEmail,
  safeCompare,
} from "./verification"
import type { LoginDto } from "./dto/login.dto"
import type { SelectProjectDto } from "./dto/select-project.dto"
import type { ChangePasswordDto } from "./dto/change-password.dto"
import type { RequestCodeDto } from "./dto/request-code.dto"
import type { VerifyCodeDto } from "./dto/verify-code.dto"
import type { SetPasswordDto } from "./dto/set-password.dto"

const CREDENCIAIS_INVALIDAS = "Credenciais inválidas"
const CODIGO_INVALIDO = "Código inválido ou expirado"

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
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  // ── Auth por código (passwordless — auth única) ──────────────────────

  /**
   * Rate-limit do request-code em memória (3/15 min por e-mail+IP,
   * configurável por env). Suficiente para a plataforma atual (um processo);
   * multi-instância exigiria store compartilhado.
   */
  private readonly pedidosCodigo = new Map<
    string,
    { count: number; janelaInicio: number }
  >()

  private chaveRateLimit(email: string, ip: string): string {
    return email.toLowerCase() + "|" + ip
  }

  private permitidoPedirCodigo(chave: string): boolean {
    const agora = Date.now()
    const atual = this.pedidosCodigo.get(chave)
    if (!atual || agora - atual.janelaInicio >= this.env.authRateLimitWindowMs) {
      return true
    }
    return atual.count < this.env.authRateLimitMax
  }

  private registrarPedidoCodigo(chave: string): void {
    const agora = Date.now()
    const atual = this.pedidosCodigo.get(chave)
    if (!atual || agora - atual.janelaInicio >= this.env.authRateLimitWindowMs) {
      this.pedidosCodigo.set(chave, { count: 1, janelaInicio: agora })
    } else {
      atual.count += 1
    }
  }

  /**
   * Pede um código por e-mail. Resposta SEMPRE { ok: true } — e-mail
   * inválido, inexistente ou rate-limited não revelam nada (D4).
   */
  async requestCode(dto: RequestCodeDto, ip: string): Promise<RequestCodeResponse> {
    const email = dto.email.trim().toLowerCase()
    if (!isValidEmail(email)) {
      return { ok: true }
    }
    const chave = this.chaveRateLimit(email, ip)
    if (!this.permitidoPedirCodigo(chave)) {
      return { ok: true }
    }
    this.registrarPedidoCodigo(chave)

    const usuario = await this.repo.findUsuarioByIdentifier("email", email)
    if (!usuario || !usuario.ativo) {
      // Mesma resposta — nada revelado.
      return { ok: true }
    }

    const codigo = generateCode()
    const expiresAt = new Date(Date.now() + this.env.authCodeTtlMs)
    await this.repo.createEmailVerification({
      email,
      codeHash: hashCode(codigo, email, this.env.authCodeSecret),
      expiresAt,
    })
    await this.email.sendVerificationEmail({ to: email, code: codigo })
    return { ok: true }
  }

  /**
   * Valida o código (HMAC + TTL + tentativas).
   * - Sem senha (conta provisionada): token efêmero p/ set-password.
   * - Com senha: login completo (mesmo formato do login por senha).
   */
  async verifyCode(dto: VerifyCodeDto): Promise<VerifyCodeResponse> {
    const email = dto.email.trim().toLowerCase()
    const linha = await this.repo.getActiveEmailVerification(email)
    if (!linha) {
      throw new UnauthorizedException(CODIGO_INVALIDO)
    }

    const hash = hashCode(dto.code, email, this.env.authCodeSecret)
    if (!safeCompare(hash, linha.codeHash)) {
      await this.repo.incrementVerificationAttempts(linha.id)
      // Estourou o máximo de tentativas → invalida o código.
      if (linha.attempts + 1 >= this.env.authMaxAttempts) {
        await this.repo.markVerificationUsed(linha.id)
      }
      throw new UnauthorizedException(CODIGO_INVALIDO)
    }
    await this.repo.markVerificationUsed(linha.id)

    const usuario = await this.repo.findUsuarioByIdentifier("email", email)
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException(CODIGO_INVALIDO)
    }

    if (!usuario.passwordHash) {
      const verificationToken = await this.jwt.signAsync(
        { sub: usuario.id },
        {
          expiresIn: this.env.authVerifyTokenTtl as JwtSignOptions["expiresIn"],
        },
      )
      return { primeiraVez: true, verificationToken }
    }

    const refreshToken = await this.issueRefreshToken(usuario.id)
    const projetos = await this.repo.listProjetosDoUsuario(usuario.id)
    return {
      primeiraVez: false,
      refreshToken,
      usuario: toUsuarioAutenticado(usuario),
      projetos,
    }
  }

  /**
   * Define a senha na 1ª vez. Autenticado pelo token efêmero (JWT curto
   * assinado com JWT_SECRET, claim { sub }) emitido no verify-code.
   */
  async setPassword(dto: SetPasswordDto): Promise<SetPasswordResponse> {
    let claims: { sub: number }
    try {
      claims = await this.jwt.verifyAsync<{ sub: number }>(dto.verificationToken)
    } catch {
      throw new UnauthorizedException(
        "Token de verificação inválido ou expirado",
      )
    }
    const usuario = await this.repo.findUsuarioById(claims.sub)
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException(CODIGO_INVALIDO)
    }
    const novoHash = await argon2.hash(dto.novaSenha, {
      type: argon2.argon2id,
    })
    await this.repo.updatePasswordHash(usuario.id, novoHash)
    return { ok: true }
  }

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
    // Conta sem senha (provisionada para entrar por código) não loga por senha.
    if (!usuario.passwordHash) {
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
    // Sem senha definida não há senha atual para conferir — usa o fluxo de código.
    if (!usuario.passwordHash) {
      throw new BadRequestException("Senha atual incorreta")
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
    const expiresIn =
      this.env.jwtAccessExpiration as JwtSignOptions["expiresIn"]
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
