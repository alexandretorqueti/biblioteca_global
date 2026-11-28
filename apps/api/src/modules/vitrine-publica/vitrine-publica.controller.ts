/**
 * VitrinePublicaController — endpoints públicos da vitrine (macro #10).
 *
 * Rotas PÚBLICAS (prefixo /api/vitrine), sempre sob o controle deste módulo:
 * - `GET /vitrine/conteudo`  — conteúdo ativo da vitrine (posição 2/11);
 * - `POST /vitrine/pedidos`  — criação pública do pedido (multipart: campo
 *   `dados` JSON + 0..N arquivos `arquivos` + campo `textoLivre`);
 * - `GET /vitrine/pedidos/:token` — acompanhamento do pedido pelo token.
 *
 * Sem guard de auth (padrão `@Public()` do módulo vendas; o ThrottlerGuard
 * global já protege contra abuso). A resolução do banco é 100% server-side
 * no service (slug fixo → core → ProjectDbFactory) — nada do cliente
 * seleciona projeto, tabela ou campo. **Não existe listagem pública de
 * pedidos** (nenhuma rota `GET /vitrine/pedidos` é registrada).
 *
 * Upload no padrão `gestao-tarefas-global-anexos`: `FilesInterceptor` em
 * memória com `limits.fileSize` lido do env no decorator (defesa de
 * memória; validação canônica no service) + `ErroUploadVitrineFilter`
 * convertendo `MulterError` em 400 claro.
 *
 * Sem colisão de rota: o CRUD dinâmico é `/api/:slug/:resource` e só casa
 * slugs de projetos registrados — `vitrine` não é slug
 * (o projeto é `vitrine-ia-loja-de-atendentes-virtuais`); além disso o
 * VitrinePublicaModule é importado ANTES do CrudModule no AppModule, então a
 * rota estática vence o padrão parametrizado (mesma precedência usada pelos
 * módulos de fluxo/visões de gestao-de-tarefas-global). `/api/vendas/planos`
 * (ISA legado) vive em prefixo próprio e não intercepta `vitrine/...`.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common"
import { FilesInterceptor } from "@nestjs/platform-express"
import type {
  VitrinePedidoAcompanhamento,
  VitrinePedidoCriacaoResposta,
  VitrinePublicaConteudo,
} from "@biblioteca-global/shared"
import { Public } from "../../common/decorators/public.decorator"
import { VitrinePublicaService } from "./vitrine-publica.service"
import {
  VitrinePedidosService,
  type ArquivoVitrineMultipart,
} from "./vitrine-pedidos.service"
import {
  VITRINE_MAX_ARQUIVOS_POR_PEDIDO,
  limiteUploadVitrineBytes,
} from "./vitrine-pedidos.constantes"
import { ErroUploadVitrineFilter } from "./erro-upload-vitrine.filter"

@Controller("vitrine")
export class VitrinePublicaController {
  constructor(
    private readonly service: VitrinePublicaService,
    private readonly pedidosService: VitrinePedidosService,
  ) {}

  @Public()
  @Get("conteudo")
  conteudo(): Promise<VitrinePublicaConteudo> {
    return this.service.obterConteudo()
  }

  /**
   * Criação pública do pedido (multipart). `ErroUploadVitrineFilter`:
   * `MulterError` (ex.: LIMIT_FILE_SIZE) → 400 citando o máximo, em vez do
   * 500 do filtro global. Memória (storage padrão do multer) com `maxCount`
   * de arquivos e `fileSize` lidos do env no decorator.
   */
  @Public()
  @Post("pedidos")
  @UseFilters(ErroUploadVitrineFilter)
  @UseInterceptors(
    FilesInterceptor("arquivos", VITRINE_MAX_ARQUIVOS_POR_PEDIDO, {
      limits: { fileSize: limiteUploadVitrineBytes() },
    }),
  )
  criarPedido(
    @Body("dados") dados: unknown,
    @Body("textoLivre") textoLivre: unknown,
    @UploadedFiles() arquivos: ArquivoVitrineMultipart[] | undefined,
  ): Promise<VitrinePedidoCriacaoResposta> {
    return this.pedidosService.criar(dados, textoLivre, arquivos)
  }

  /** Acompanhamento pelo token — somente o pedido do token (404 caso contrário). */
  @Public()
  @Get("pedidos/:token")
  acompanharPedido(
    @Param("token") token: string,
  ): Promise<VitrinePedidoAcompanhamento> {
    return this.pedidosService.acompanhar(token)
  }
}
