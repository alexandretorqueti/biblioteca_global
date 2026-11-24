/**
 * EscopoOrganizacaoPorSlugGuard — aplica o EscopoOrganizacaoGuard (tenancy
 * intra-projeto, projects/gestao-de-tarefas-global/src/tenancy) SOMENTE às
 * rotas do CRUD genérico cujo slug é `gestao-de-tarefas-global`.
 *
 * Registrado na chain do CrudController depois de JwtAuthGuard +
 * ProjectScopeGuard (req.scope já resolvido). Para qualquer outro slug o
 * guard é transparente (retorna true sem tocar no banco) — comportamento dos
 * demais projetos permanece intocado.
 *
 * Recursos virtuais (ex.: __openclaw_agentes__) não são dados de negócio do
 * projeto e também passam sem resolução de tenancy.
 *
 * Sucesso → req.escopoOrganizacao preenchido (contexto colaborador/master),
 * consumido pelo CrudController e repassado ao CrudService/ExtensaoEscopoCrud.
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common"
import { EscopoOrganizacaoGuard } from "../../../../../../projects/gestao-de-tarefas-global/src/tenancy/escopo-organizacao.guard"
import { VIRTUAL_RESOURCE_OPENCLAW_AGENTES } from "../crud.service"
import { SLUG_GESTAO_TAREFAS_GLOBAL } from "./gestao-tarefas-global.escopo"

@Injectable()
export class EscopoOrganizacaoPorSlugGuard implements CanActivate {
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
    if (req.params?.resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) return true
    return this.delegado.canActivate(context)
  }
}
