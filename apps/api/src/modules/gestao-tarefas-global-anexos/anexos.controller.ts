/**
 * AnexosController — anexos de tarefas (gestao-de-tarefas-global — macro #6,
 * subtarefa 1).
 *
 * Rotas (prefixo /api) — sempre sob o slug do projeto da sessão:
 * - POST /:slug/tarefas/:id/anexos                       (multipart, campo 'arquivo')
 * - GET  /:slug/tarefas/:id/anexos                       (lista: nome, tipo, tamanho, autor nome, data)
 * - GET  /:slug/tarefas/:id/anexos/:anexoId/download     (StreamableFile; inline p/ png|jpeg|pdf, senão attachment)
 * - GET  /:slug/tarefas/:id/anexos/:anexoId/preview      (idem)
 *
 * Guards: JwtAuthGuard + ProjectScopeGuard (req.scope) + EscopoFluxoPorSlugGuard
 * (EscopoOrganizacaoGuard condicionado ao slug — req.escopoOrganizacao =
 * colaborador ativo da organização; exportado pelo módulo fluxo).
 *
 * Segurança:
 * - `enviadoPorId` é SEMPRE o colaborador da sessão (guard) — nunca body;
 * - upload: limite ~10MB via multer (FileInterceptor) + validação no
 *   service (dupla defesa) com erro claro citando o máximo; erro de
 *   tamanho no parse multipart é convertido em 400 pelo `ErroUploadFilter`;
 * - escopo row-level: tarefa OU anexo de outra organização → 404;
 * - NENHUMA rota PUT/PATCH/DELETE (anexos e histórico são append-only por
 *   construção);
 * - o caminho físico do servidor nunca aparece na resposta — somente o id
 *   do anexo e as metadados (nome, tipo, tamanho, autor, data).
 */
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { RequisicaoComEscopoOrganizacao } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import {
  GestaoTarefasGlobalAnexosService,
  type ArquivoAnexoMultipart,
} from "./anexos.service"
import { limiteUploadAnexoBytes } from "./anexos.constantes"
import { EscopoFluxoPorSlugGuard } from "../gestao-tarefas-global-fluxo/escopo-fluxo-por-slug.guard"
import { ErroUploadFilter } from "./erro-upload.filter"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard, EscopoFluxoPorSlugGuard)
export class AnexosController {
  constructor(private readonly service: GestaoTarefasGlobalAnexosService) {}

  /**
   * Upload multipart (campo 'arquivo', memória — validamos e gravamos no
   * ANEXOS_DIR com a chave lógica org/{org}/tarefa/{id}/{uuid}.{ext}).
   * `ErroUploadFilter`: `MulterError` (ex.: limite de tamanho) → 400 com
   * mensagem clara, em vez do 500 do filtro global.
   */
  @Post(":slug/tarefas/:id/anexos")
  @UseFilters(ErroUploadFilter)
  @UseInterceptors(
    FileInterceptor("arquivo", {
      // memória (storage padrão do multer) + limite de bytes lido do env no
      // momento do request (decorator não tem acesso à DI — ver constantes).
      limits: { fileSize: limiteUploadAnexoBytes() },
    }),
  )
  async anexar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @UploadedFile() arquivo: ArquivoAnexoMultipart,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.anexar(projeto, ctx, id, arquivo)
  }

  /** Lista dos anexos da tarefa (antigo → novo). */
  @Get(":slug/tarefas/:id/anexos")
  async listar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.listar(projeto, ctx, id)
  }

  /** Download (Content-Disposition conforme o tipo). */
  @Get(":slug/tarefas/:id/anexos/:anexoId/download")
  async download(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Param("anexoId", ParseIntPipe) anexoId: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.baixar(projeto, ctx, id, anexoId)
  }

  /** Preview (inline para image/png, image/jpeg e application/pdf). */
  @Get(":slug/tarefas/:id/anexos/:anexoId/preview")
  async preview(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Param("anexoId", ParseIntPipe) anexoId: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.baixar(projeto, ctx, id, anexoId)
  }
}
