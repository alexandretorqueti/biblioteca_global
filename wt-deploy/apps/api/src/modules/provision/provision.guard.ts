/**
 * ProvisionGuard — protege as rotas de provisionamento (Etapa 6).
 * Exige `Authorization: Bearer <PROVISION_TOKEN>` (token de serviço do
 * GerenteAgentes). Comparação com timingSafeEqual; nunca logar o token (D8).
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import type { ApiRequest } from "../../common/types"
import { EnvService } from "../../config/env.service"
import { safeCompare } from "../auth/verification"

@Injectable()
export class ProvisionGuard implements CanActivate {
  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const header = req.headers.authorization
    const token = typeof header === "string" ? header : ""
    const bearer = token.startsWith("Bearer ") ? token.slice("Bearer ".length) : ""

    const esperado = this.env.provisionToken
    if (!bearer || !safeCompare(bearer, esperado)) {
      throw new UnauthorizedException("Token de serviço inválido")
    }
    return true
  }
}
