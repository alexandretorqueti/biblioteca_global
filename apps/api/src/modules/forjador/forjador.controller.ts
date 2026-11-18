import { Body, Controller, Post, UseGuards } from "@nestjs/common"
import type { ForjarPersonaRequest, ForjarPersonaResponse } from "@biblioteca-global/shared"
import { ForjadorGuard } from "./forjador.guard"
import { ForjadorService } from "./forjador.service"

@Controller("forjador")
@UseGuards(ForjadorGuard)
export class ForjadorController {
  constructor(private readonly service: ForjadorService) {}

  @Post("forjar-persona")
  forjarPersona(@Body() body: ForjarPersonaRequest): Promise<ForjarPersonaResponse> {
    return this.service.forjarPersona(body)
  }
}
