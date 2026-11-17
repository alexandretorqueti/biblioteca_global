import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { ApiRequest } from "../../common/types"
import { KnowledgeBaseService } from "./knowledge-base.service"

@Controller("knowledge-base/documents")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class KnowledgeBaseController {
  constructor(private readonly service: KnowledgeBaseService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor("file"))
  async upload(@Request() req: ApiRequest, @UploadedFile() file?: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    const projetoId = req.authClaims?.projetoId
    if (!projetoId) throw new BadRequestException("Projeto autenticado ausente")
    if (!file) throw new BadRequestException("Envie um arquivo no campo file")
    return this.service.indexar(projetoId, file)
  }

  @Delete(":id")
  @HttpCode(204)
  async remover(@Request() req: ApiRequest, @Param("id") idParam: string): Promise<void> {
    const projetoId = req.authClaims?.projetoId
    const id = Number(idParam)
    if (!projetoId || !Number.isInteger(id) || id <= 0) {
      throw new BadRequestException("id e projeto autenticado são obrigatórios")
    }
    await this.service.remover(projetoId, id)
  }

  @Get(":id/status")
  async status(@Request() req: ApiRequest, @Param("id") idParam: string) {
    const projetoId = req.authClaims?.projetoId
    const id = Number(idParam)
    if (!projetoId || !Number.isInteger(id) || id <= 0) {
      throw new BadRequestException("id e projeto autenticado são obrigatórios")
    }
    return this.service.status(projetoId, id)
  }
}
