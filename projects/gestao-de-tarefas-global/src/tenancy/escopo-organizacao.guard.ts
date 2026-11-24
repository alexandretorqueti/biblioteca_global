/**
 * EscopoOrganizacaoGuard — guard de escopo organização+colaborador por request
 * (tenancy intra-projeto, gestao-de-tarefas-global).
 *
 * Pré-requisitos na chain: JwtAuthGuard (+ ProjectScopeGuard) — o escopo da
 * sessão vem SEMPRE de `req.scope` (claims do token), nunca de body/query/header.
 *
 * Comportamento:
 * - sessão no projeto `biblioteca-global` → master da plataforma (padrão
 *   global-admin): reconhecido sem colaborador e NÃO consulta o banco do
 *   projeto; só transita nos endpoints de master (subtarefa 3), nunca em
 *   dados de negócio (`exigirContextoColaborador` nos resolvers);
 * - demais sessões → resolve `colaboradores.usuario_id = sub` com
 *   `ativo = true` via RepositorioTenancy (banco do projeto projeto_<id>);
 * - sem colaborador ativo → 403 com mensagem clara (SemColaboradorAtivoError
 *   propagado pelo ApiExceptionFilter como FORBIDDEN);
 * - sucesso → injeta `req.escopoOrganizacao` = { organizacaoId,
 *   colaboradorId, perfil } (ou master) para handlers e guards seguintes.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import {
  exigirContextoColaborador,
  resolverContextoEscopo,
} from "./resolvers"
import {
  SemColaboradorAtivoError,
  SLUG_MASTER_PLATAFORMA,
  type ContextoEscopoOrganizacao,
  type RequisicaoComEscopoOrganizacao,
  type RepositorioTenancy,
} from "./tipos"

/** Token de DI do repositório de tenancy (implementação usa o banco do projeto). */
export const REPOSITORIO_TENANCY = Symbol("REPOSITORIO_TENANCY")

@Injectable()
export class EscopoOrganizacaoGuard implements CanActivate {
  constructor(
    @Inject(REPOSITORIO_TENANCY)
    private readonly repositorio: RepositorioTenancy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequisicaoComEscopoOrganizacao>()
    if (!req.scope) {
      throw new UnauthorizedException(
        "Sessão de projeto ausente — EscopoOrganizacaoGuard exige JwtAuthGuard + ProjectScopeGuard na chain.",
      )
    }

    const contexto = await this.resolverContexto(req)
    req.escopoOrganizacao = contexto
    return true
  }

  /**
   * Resolve o contexto; master não consulta o banco do projeto.
   * `SemColaboradorAtivoError` → 403 com a mensagem canônica.
   */
  private async resolverContexto(
    req: RequisicaoComEscopoOrganizacao,
  ): Promise<ContextoEscopoOrganizacao> {
    const scope = req.scope as NonNullable<RequisicaoComEscopoOrganizacao["scope"]>
    if (scope.projeto.slug === SLUG_MASTER_PLATAFORMA) {
      // Master: resolução pura, sem tocar em dados do projeto.
      return resolverContextoEscopo({ scope, colaboradores: [] })
    }
    const colaboradores =
      await this.repositorio.listarColaboradoresPorUsuario(scope.usuario.id)
    try {
      return resolverContextoEscopo({ scope, colaboradores })
    } catch (error) {
      if (error instanceof SemColaboradorAtivoError) {
        throw new ForbiddenException(error.message)
      }
      throw error
    }
  }
}

/**
 * Helper para controllers: contexto de colaborador obrigatório em recurso de
 * negócio (rejeita master com 403). Facilita o uso conjunto com o guard.
 */
export function contextoColaboradorDaRequest(
  req: RequisicaoComEscopoOrganizacao,
): Extract<ContextoEscopoOrganizacao, { tipo: "colaborador" }> {
  if (!req.escopoOrganizacao) {
    throw new UnauthorizedException(
      "Contexto de organização não resolvido — EscopoOrganizacaoGuard não executou.",
    )
  }
  return exigirContextoColaborador(req.escopoOrganizacao)
}
