import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from "@nestjs/common"
import type { RetificacaoRequest } from "@biblioteca-global/shared"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { ProjectScope } from "../../common/types"
import { LgpdService } from "./lgpd.service"

@Controller("usuarios")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class LgpdController {
  constructor(private readonly service: LgpdService) {}

  @Get(":id/export")
  exportar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) usuarioId: number,
    @Headers("x-forwarded-for") forwardedFor: string | undefined,
  ) {
    return this.service.exportar(
      { usuario, projeto },
      usuarioId,
      forwardedFor?.split(",")[0]?.trim() ?? null,
    )
  }

  @Put(":id/dados")
  retificar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) usuarioId: number,
    @Body() dados: RetificacaoRequest,
    @Headers("x-forwarded-for") forwardedFor: string | undefined,
  ) {
    return this.service.retificar(
      { usuario, projeto },
      usuarioId,
      dados,
      forwardedFor?.split(",")[0]?.trim() ?? null,
    )
  }

  @Delete(":id/dados")
  excluir(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) usuarioId: number,
    @Headers("x-forwarded-for") forwardedFor: string | undefined,
  ) {
    return this.service.excluir(
      { usuario, projeto },
      usuarioId,
      forwardedFor?.split(",")[0]?.trim() ?? null,
    )
  }
}
