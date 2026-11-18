import {
  Controller,
  Get,
  Param,
  Res,
} from "@nestjs/common"
import { Public } from "../../common/decorators/public.decorator"
import type { TenantChatConfig } from "@biblioteca-global/shared"
import type { Response } from "express"
import { TenantsService, type SuspendedTenantResponse } from "./tenants.service"

@Controller("tenants")
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  @Public()
  @Get(":slug/chat-config")
  async chatConfig(
    @Param("slug") slug: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TenantChatConfig | SuspendedTenantResponse> {
    const config = await this.service.getChatConfig(slug)
    if ("status" in config) {
      response.status(403)
      return config
    }
    response.setHeader("Cache-Control", "public, max-age=60")
    return config
  }
}
