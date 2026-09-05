/**
 * helpdesk.controller.ts — Endpoints do HelpDesk (autenticados com JWT).
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Logger,
  HttpStatus,
  HttpCode,
  BadRequestException,
  Request,
  UseGuards,
} from "@nestjs/common"
import { HelpDeskService } from "./helpdesk.service"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { ApiRequest } from "../../common/types"

@Controller("helpdesk")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class HelpDeskController {
  private readonly logger = new Logger(HelpDeskController.name)

  constructor(private readonly service: HelpDeskService) {}

  @Post("session")
  @HttpCode(HttpStatus.OK)
  async criarSessao(
    @Request() req: ApiRequest,
  ) {
    const usuarioId = req.authClaims?.sub ?? 0
    const projetoId = req.authClaims?.projetoId ?? 0

    if (!usuarioId || !projetoId) {
      throw new BadRequestException("usuarioId e projetoId são obrigatórios")
    }

    return this.service.criarOuRetomarSessao({ usuarioId, projetoId })
  }

  @Post("send")
  @HttpCode(HttpStatus.OK)
  async enviar(
    @Request() req: ApiRequest,
    @Body() body: { sessaoId: number; text: string },
  ) {
    const sessaoId = typeof body?.sessaoId === "number" ? body.sessaoId : 0
    const text = typeof body?.text === "string" ? body.text.trim() : ""

    if (!sessaoId || !text) {
      throw new BadRequestException("sessaoId e text são obrigatórios")
    }

    const usuarioId = req.authClaims?.sub ?? 0
    if (!usuarioId) throw new BadRequestException("Usuário autenticado ausente")
    return this.service.enviarMensagem({ sessaoId, text, usuarioId })
  }

  @Get(":sessaoId/history")
  async obterHistorico(
    @Request() req: ApiRequest,
    @Param("sessaoId") sessaoIdParam: string,
  ) {
    const sessaoId = Number(sessaoIdParam)
    if (!Number.isInteger(sessaoId) || sessaoId <= 0) {
      throw new BadRequestException("sessaoId deve ser um número inteiro positivo")
    }
    const usuarioId = req.authClaims?.sub ?? 0
    if (!usuarioId) throw new BadRequestException("Usuário autenticado ausente")
    return this.service.obterHistorico(sessaoId, usuarioId)
  }
}
