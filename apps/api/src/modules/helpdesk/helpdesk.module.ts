/**
 * helpdesk.module.ts — Módulo HelpDesk. Register em app.module.ts.
 */
import { Module } from "@nestjs/common"
import { HelpDeskController } from "./helpdesk.controller"
import { HelpDeskService } from "./helpdesk.service"
import { HelpDeskBridgeService } from "./helpdesk.bridge"
import { CrudModule } from "../crud/crud.module"

@Module({
  imports: [CrudModule],
  controllers: [HelpDeskController],
  providers: [HelpDeskService, HelpDeskBridgeService],
  exports: [HelpDeskService],
})
export class HelpDeskModule {}
