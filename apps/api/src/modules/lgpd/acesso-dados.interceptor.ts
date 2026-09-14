import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common"
import type { Observable } from "rxjs"
import type { ApiRequest } from "../../common/types"
import { AcessoDadosService } from "./acesso-dados.service"

@Injectable()
export class AcessoDadosInterceptor implements NestInterceptor {
  constructor(private readonly acesso: AcessoDadosService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ApiRequest & { params?: Record<string, string> }>()
    const usuarioId = Number(request.params?.id)
    if (request.authClaims && Number.isInteger(usuarioId) && usuarioId > 0) {
      void this.acesso.registrar({
        usuarioId,
        acao: request.method === "GET" ? "consulta" : request.method === "PUT" ? "retificacao" : "exclusao",
        ip: request.ip ?? null,
      })
    }
    return next.handle()
  }
}
