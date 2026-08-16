/**
 * ProvisionController — endpoints de provisionamento (auth única, Etapa 6).
 * Chamado pelo GerenteAgentes ao concluir um projeto (token de serviço).
 */
import {
  Body,
  Controller,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common"
import type {
  ProvisionProjectRequest,
  ProvisionProjectResponse,
} from "@biblioteca-global/shared"
import { ProvisionGuard } from "./provision.guard"
import { ProvisionService } from "./provision.service"

@Controller("provision")
@UseGuards(ProvisionGuard)
export class ProvisionController {
  constructor(
    @Inject(ProvisionService) private readonly provisionService: ProvisionService,
  ) {}

  /** Garante o acesso do cliente ao projeto (idempotente, admin automático). */
  @Post("project")
  provisionProject(
    @Body() dto: ProvisionProjectRequest,
  ): Promise<ProvisionProjectResponse> {
    return this.provisionService.provisionProject(dto)
  }
}
