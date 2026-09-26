import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common"
import type { UsuarioAutenticado } from "@biblioteca-global/shared"
import type { ApiRequest } from "../types"

function scopeDe(ctx: ExecutionContext) {
  const req = ctx.switchToHttp().getRequest<ApiRequest>()
  if (!req.scope) {
    throw new InternalServerErrorException(
      "Escopo do projeto não resolvido — use ProjectScopeGuard antes",
    )
  }
  return req.scope
}

/** Usuário autenticado da sessão (sem password_hash — nunca). */
export const CurrentUser = createParamDecorator(
  (_dados: unknown, ctx: ExecutionContext): UsuarioAutenticado =>
    scopeDe(ctx).usuario,
)

/** Projeto da sessão + perfil — derivados do token, nunca do body. */
export const CurrentProject = createParamDecorator(
  (_dados: unknown, ctx: ExecutionContext) => scopeDe(ctx).projeto,
)

/**
 * ID do funcionário autenticado — derivado do userId do token.
 * Para o TaQui, o funcionário é vinculado ao usuário via tabela funcionarios
 * com campo email ou userId correspondente. Como não há vínculo direto,
 * usamos o userId do token como fallback (o service valida se é funcionário).
 */
export const CurrentFuncionarioId = createParamDecorator(
  (_dados: unknown, ctx: ExecutionContext): number => {
    const scope = scopeDe(ctx)
    // Para o TaQui, o funcionárioId é o próprio userId do token
    // (a validação de pertencimento ao condomínio é feita no service)
    return scope.usuario.id
  },
)
