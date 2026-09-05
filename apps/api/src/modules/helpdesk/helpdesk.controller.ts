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
} from "@nestjs/common"
import { HelpDeskService } from "./helpdesk.service"

@Controller("helpdesk")
export class HelpDeskController {
  private readonly logger = new Logger(HelpDeskController.name)

  constructor(private readonly service: HelpDeskService) {}

  @Post("session")
  @HttpCode(HttpStatus.OK)
  async criarSessao(
    @Body() body: { usuarioId: number; projetoId: number },
  ) {
    const usuarioId = typeof body?.usuarioId === "number" ? body.usuarioId : 0
    const projetoId = typeof body?.projetoId === "number" ? body.projetoId : 0

    if (!usuarioId || !projetoId) {
      throw new BadRequestException("usuarioId e projetoId são obrigatórios")
    }

    return this.service.criarOuRetomarSessao({ usuarioId, projetoId })
  }

  @Post("send")
  @HttpCode(HttpStatus.OK)
  async enviar(
    @Body() body: { sessaoId: number; text: string; usuarioId?: number },
  ) {
    const sessaoId = typeof body?.sessaoId === "number" ? body.sessaoId : 0
    const text = typeof body?.text === "string" ? body.text.trim() : ""

    if (!sessaoId || !text) {
      throw new BadRequestException("sessaoId e text são obrigatórios")
    }

    return this.service.enviarMensagem({ sessaoId, text, usuarioId: 0 })
  }

  @Get(":sessaoId/history")
  async obterHistorico(@Param("sessaoId") sessaoIdParam: string) {
    const sessaoId = Number(sessaoIdParam)
    if (!Number.isInteger(sessaoId) || sessaoId <= 0) {
      throw new BadRequestException("sessaoId deve ser um número inteiro positivo")
    }
    return this.service.obterHistorico(sessaoId)
  }
}
