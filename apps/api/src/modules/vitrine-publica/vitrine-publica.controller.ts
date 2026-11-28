/**
 * VitrinePublicaController — `GET /api/vitrine/conteudo` (macro #10, 2/11).
 *
 * Rota PÚBLICA read-only do conteúdo ativo da vitrine (REQ-F-001): sem guard
 * de auth (padrão `@Public()` do módulo vendas; o ThrottlerGuard global já
 * protege contra abuso). A resolução do banco é 100% server-side no service
 * (slug fixo → core → ProjectDbFactory) — nada do cliente seleciona projeto,
 * tabela ou campo.
 *
 * Sem colisão de rota: o CRUD dinâmico é `/api/:slug/:resource` e só casa
 * slugs de projetos registrados — `vitrine` não é slug
 * (o projeto é `vitrine-ia-loja-de-atendentes-virtuais`); além disso o
 * VitrinePublicaModule é importado ANTES do CrudModule no AppModule, então a
 * rota estática vence o padrão parametrizado (mesma precedência usada pelos
 * módulos de fluxo/visões de gestao-de-tarefas-global). `/api/vendas/planos`
 * (ISA legado) vive em prefixo próprio e não intercepta `vitrine/...`.
 */
import { Controller, Get } from "@nestjs/common"
import type { VitrinePublicaConteudo } from "@biblioteca-global/shared"
import { Public } from "../../common/decorators/public.decorator"
import { VitrinePublicaService } from "./vitrine-publica.service"

@Controller("vitrine")
export class VitrinePublicaController {
  constructor(private readonly service: VitrinePublicaService) {}

  @Public()
  @Get("conteudo")
  conteudo(): Promise<VitrinePublicaConteudo> {
    return this.service.obterConteudo()
  }
}
