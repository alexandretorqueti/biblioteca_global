import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common"
import type { ApiRequest } from "../../common/types"
import { EnvService } from "../../config/env.service"
import { safeCompare } from "../auth/verification"

@Injectable()
export class RealtimeIngressGuard implements CanActivate {
  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
    const expected = this.env.libraryRealtimeEventsToken
    if (!expected || !token || !safeCompare(token, expected)) {
      throw new UnauthorizedException("Token realtime inválido")
    }
    return true
  }
}
