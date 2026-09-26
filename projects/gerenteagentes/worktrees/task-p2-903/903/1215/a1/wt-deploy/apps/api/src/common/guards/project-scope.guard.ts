/**
 * ProjectScopeGuard — regra de segurança central (PoC §5.2):
 * o escopo vem do token; a pivot projetos_usuarios e usuario.ativo são
 * REVALIDADAS a cada request. Vínculo removido → 403 imediato.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common"
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from "../../modules/auth/auth.repository"
import type { ApiRequest } from "../types"

@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const claims = req.authClaims
    if (!claims || typeof claims.projetoId !== "number") {
      throw new ForbiddenException("Token sem escopo de projeto")
    }

    const scope = await this.repo.resolveScope(claims.sub, claims.projetoId)
    if (!scope) {
      throw new ForbiddenException(
        "Vínculo com o projeto não encontrado ou usuário inativo",
      )
    }

    req.scope = scope
    return true
  }
}
