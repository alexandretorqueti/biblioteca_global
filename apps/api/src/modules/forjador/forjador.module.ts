import { Module } from "@nestjs/common"
import { EnvModule } from "../../config/env.module"
import { ForjadorBridgeService } from "./forjador.bridge"
import { ForjadorController } from "./forjador.controller"
import { ForjadorGuard } from "./forjador.guard"
import { ForjadorService } from "./forjador.service"

@Module({
  imports: [EnvModule],
  controllers: [ForjadorController],
  providers: [ForjadorBridgeService, ForjadorGuard, ForjadorService],
  exports: [ForjadorService],
})
export class ForjadorModule {}
