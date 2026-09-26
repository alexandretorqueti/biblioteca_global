/**
 * RolesGuard — libera ações por perfil dentro do projeto da sessão.
 * Uso: depois de JwtAuthGuard + ProjectScopeGuard.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Perfil } from "@biblioteca-global/shared"
import { ROLES_KEY } from "../decorators/roles.decorator"
import type { ApiRequest } from "../types"

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const perfis = this.reflector.getAllAndOverride<Perfil[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!perfis || perfis.length === 0) return true

    const req = context.switchToHttp().getRequest<ApiRequest>()
    const perfil = req.scope?.projeto.perfil
    if (!perfil || !perfis.includes(perfil)) {
      throw new ForbiddenException(
        "Perfil insuficiente para esta operação",
      )
    }
    return true
  }
}
