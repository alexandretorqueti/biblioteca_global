/**
 * RefreshAuthGuard — valida o REFRESH TOKEN (opaco, persistido em
 * refresh_tokens) usado em select-project / refresh / logout.
 */
import { createHash } from "node:crypto"
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { extractBearer } from "../bearer"
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from "../../modules/auth/auth.repository"
import type { ApiRequest } from "../types"

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

@Injectable()
export class RefreshAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const token = extractBearer(req.headers.authorization)
    if (!token) {
      throw new UnauthorizedException("Refresh token ausente")
    }

    const linha = await this.repo.findRefreshTokenByHash(hashToken(token))
    if (!linha || linha.revoked || linha.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Refresh token inválido ou expirado")
    }

    const usuario = await this.repo.findUsuarioById(linha.usuarioId)
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException("Usuário não encontrado ou inativo")
    }

    req.refreshSession = {
      tokenId: linha.id,
      usuarioId: linha.usuarioId,
      token,
    }
    return true
  }
}
