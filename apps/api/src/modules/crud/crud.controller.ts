/**
 * CrudController — rotas genéricas /api/:slug/:resource (PoC §6.2).
 * Registrado por ÚLTIMO no AppModule: rotas específicas (auth, usuarios,
 * projetos) têm precedência; resources reservados são bloqueados no service.
 * Escrita exige perfil admin/gerente/operador; visualizador só lê.
 *
 * Rotas namespaced: /api/<slug>/<resource> (ex.: /api/taqui/tarefas).
 * O slug é validado contra o schema registry; resource contra a whitelist
 * do projeto. Rotas antigas /api/:resource foram removidas.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import {
  CrudService,
  type CrudListParams,
  VIRTUAL_RESOURCE_OPENCLAW_AGENTES,
} from "./crud.service"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class CrudController {
  constructor(@Inject(CrudService) private readonly service: CrudService) {
    console.log("[CrudController] Instanciado!")
  }

  /**
   * Query sem DTO tipado de propósito: além de page/pageSize/search, as demais
   * chaves são filtros por coluna, validados no service contra a tabela.
   * `search` é especial: busca textual (OR LIKE) nas colunas de texto —
   * enviada pelo front (entity-client/ProjectContext), aplicada no service.
   * `orderBy` é opcional: formato "campo:asc,campo:desc" (validado no service).
   */
  @Get(":slug/:resource")
  listar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("resource") resource: string,
    @Query() query: Record<string, string>,
  ) {
    // Valida que o slug do projeto corresponde ao projeto do token
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const { page, pageSize, search, orderBy: orderByRaw, ...filters } = query
    const params: CrudListParams = {
      page: page !== undefined ? Number(page) : undefined,
      pageSize: pageSize !== undefined ? Number(pageSize) : undefined,
      search: search || undefined,
      filters,
    }
    // Parse orderBy: "campo:asc,campo:desc,campo:asc:v1|v2" → Array<{campo, direction, valuesLast?}>
    if (orderByRaw) {
      const items = orderByRaw.split(",").map((item) => {
        const partes = item.trim().split(":")
        if (partes.length < 2 || partes.length > 3) {
          throw new BadRequestException(`orderBy inválido: ${item}`)
        }
        const campo = (partes[0] ?? "").trim()
        const direction = (partes[1] ?? "").toLowerCase()
        if (!campo) {
          throw new BadRequestException(`orderBy inválido: campo vazio em "${item}"`)
        }
        if (direction !== "asc" && direction !== "desc") {
          throw new BadRequestException(`direction inválida: ${partes[1]} (use asc ou desc)`)
        }
        const result: { campo: string; direction: "asc" | "desc"; valuesLast?: (string | number)[] } = {
          campo,
          direction,
        }
        if (partes[2]) {
          const vals = partes[2].split("|").map((v) => v.trim()).filter(Boolean)
          result.valuesLast = vals.map((v) => {
            const num = Number(v)
            return !Number.isNaN(num) && v !== "" ? num : v
          })
        }
        return result
      })
      params.orderBy = items
    }
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      return this.service.listarVirtual(projeto, resource, params)
    }
    return this.service.listar(projeto, resource, params)
  }

  @Get(":slug/:resource/:id")
  detalhar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("resource") resource: string,
    @Param("id") idRaw: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      return this.service.detalharVirtual(projeto, resource, idRaw)
    }
    return this.service.detalhar(projeto, resource, Number(idRaw))
  }

  @Post(":slug/:resource")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  criar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("resource") resource: string,
    @Body() corpo: Record<string, unknown>,
  ) {
    console.log(`[CrudController] criar: slug=${slug}, resource=${resource}, projeto.slug=${projeto.slug}, projeto.id=${projeto.id}`)
    // Valida que o slug do projeto corresponde ao projeto do token
    if (slug !== projeto.slug) {
      console.log(`[CrudController] SLUG MISMATCH: slug da URL (${slug}) != projeto.slug do token (${projeto.slug})`)
      throw new NotFoundException("Projeto não encontrado")
    }
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new NotFoundException("Resource não encontrado")
    }
    return this.service.criar(projeto, resource, corpo)
  }

  @Put(":slug/:resource/:id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  atualizar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("resource") resource: string,
    @Param("id") idRaw: string,
    @Body() corpo: Record<string, unknown>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new NotFoundException("Resource não encontrado")
    }
    return this.service.atualizar(projeto, resource, Number(idRaw), corpo)
  }

  @Delete(":slug/:resource/:id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async remover(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("resource") resource: string,
    @Param("id") idRaw: string,
  ): Promise<{ ok: boolean }> {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new NotFoundException("Resource não encontrado")
    }
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id < 1) {
      throw new NotFoundException("Registro não encontrado")
    }
    await this.service.remover(projeto, resource, id)
    return { ok: true }
  }
}
