import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common"
import {
  errorReportRequestSchema,
  type ErrorReportRequest,
  type ProjetoResumo,
} from "@biblioteca-global/shared"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { UsuarioAutenticado } from "@biblioteca-global/shared"
import { ErrosService } from "./erros.service"

@Controller("erros")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class ErrosController {
  constructor(private readonly service: ErrosService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async registrar(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Body() body: unknown,
  ) {
    const parsed = errorReportRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Relato de erro inválido",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }

    // A identificação do usuário também é autoridade do token, nunca do
    // payload enviado pelo front.
    const relato: ErrorReportRequest = {
      ...parsed.data,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        login: usuario.username ?? usuario.email ?? undefined,
      },
    }
    return this.service.registrar(projeto.id, relato)
  }
}
