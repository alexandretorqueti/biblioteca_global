/**
 * JwtAuthGuard — valida o ACCESS TOKEN (JWT) e injeta os claims na request.
 * O escopo vem do token; rotas públicas usam @Public().
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { JwtService } from "@nestjs/jwt"
import type { Perfil } from "@biblioteca-global/shared"
import { extractBearer } from "../bearer"
import { IS_PUBLIC_KEY } from "../decorators/public.decorator"
import type { ApiRequest, AuthClaims } from "../types"

interface JwtPayload {
  sub: number
  projetoId: number
  perfil: Perfil
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ehPublica = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (ehPublica) return true

    const req = context.switchToHttp().getRequest<ApiRequest>()
    const token = extractBearer(req.headers.authorization)
    if (!token) {
      throw new UnauthorizedException("Token de acesso ausente")
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token)
      if (
        typeof payload.sub !== "number" ||
        typeof payload.projetoId !== "number" ||
        typeof payload.perfil !== "string"
      ) {
        throw new Error("claims incompletos")
      }
      const claims: AuthClaims = {
        sub: payload.sub,
        projetoId: payload.projetoId,
        perfil: payload.perfil,
      }
      req.authClaims = claims
      return true
    } catch {
      throw new UnauthorizedException("Token inválido ou expirado")
    }
  }
}
