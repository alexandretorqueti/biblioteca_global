/**
 * EscopoVisoesPorSlugGuard — aplica o EscopoOrganizacaoGuard (tenancy
 * intra-projeto, macro #2) SOMENTE quando o slug da URL é
 * `gestao-de-tarefas-global` (mesmo padrão do EscopoFluxoPorSlugGuard).
 *
 * As visões por área/tag dependem do contexto de organização da sessão —
 * para qualquer outro slug o guard é transparente (comportamento dos
 * demais projetos intocado).
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common"
import { EscopoOrganizacaoGuard } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/escopo-organizacao.guard"
import { SLUG_GESTAO_TAREFAS_GLOBAL } from "../crud/escopo/gestao-tarefas-global.escopo"

@Injectable()
export class EscopoVisoesPorSlugGuard implements CanActivate {
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
