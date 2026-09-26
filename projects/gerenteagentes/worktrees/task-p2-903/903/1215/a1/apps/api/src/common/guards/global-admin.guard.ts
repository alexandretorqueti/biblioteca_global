/**
 * GlobalAdminGuard — restrige a rota à sessão do projeto `biblioteca-global`
 * (o projeto "dono da plataforma" — PoC §8). O perfil é checado depois pelo
 * RolesGuard quando a ação é sensível.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import type { ApiRequest } from "../types"

export const SLUG_ADMIN_GLOBAL = "biblioteca-global"

@Injectable()
export class GlobalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const slug = req.scope?.projeto.slug
    if (slug !== SLUG_ADMIN_GLOBAL) {
      throw new ForbiddenException(
        "Operação exclusiva do projeto biblioteca-global",
      )
    }
    return true
  }
}
