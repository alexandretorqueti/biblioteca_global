/**
 * EscopoFluxoPorSlugGuard — aplica o EscopoOrganizacaoGuard (tenancy
 * intra-projeto, macro #2) SOMENTE quando o slug da URL é
 * `gestao-de-tarefas-global` (mesmo padrão do EscopoOrganizacaoPorSlugGuard
 * do CRUD).
 *
 * Para qualquer outro slug o guard é transparente — o fluxo custom é um
 * recurso específico deste projeto e o contexto de organização/colaborador
 * só existe aqui (evita consulta ao banco de outro projeto e mantém o
 * comportamento dos demais slugs intocado).
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common"
import { EscopoOrganizacaoGuard } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/escopo-organizacao.guard"
import { SLUG_GESTAO_TAREFAS_GLOBAL } from "../crud/escopo/gestao-tarefas-global.escopo"

@Injectable()
export class EscopoFluxoPorSlugGuard implements CanActivate {
  // @Inject explícito: DI funcional sem emitDecoratorMetadata (tsx/esbuild).
  constructor(
    @Inject(EscopoOrganizacaoGuard)
    private readonly delegado: EscopoOrganizacaoGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> | boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ params?: Record<string, string | undefined> }>()
    if (req.params?.slug !== SLUG_GESTAO_TAREFAS_GLOBAL) return true
    return this.delegado.canActivate(context)
  }
}
