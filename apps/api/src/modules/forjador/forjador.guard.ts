import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common"
import type { ApiRequest } from "../../common/types"
import { EnvService } from "../../config/env.service"
import { safeCompare } from "../auth/verification"

@Injectable()
export class ForjadorGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const authorization = req.headers.authorization
    const raw = typeof authorization === "string" ? authorization : ""
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : ""
    if (!token || !safeCompare(token, this.env.forjadorToken)) {
      throw new UnauthorizedException("Token de serviço inválido")
    }
    return true
  }
}
