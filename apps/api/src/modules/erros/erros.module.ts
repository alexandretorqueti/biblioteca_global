import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { ErrosController } from "./erros.controller"
import { ErrosService } from "./erros.service"

@Module({
  imports: [AuthModule],
  controllers: [ErrosController],
  providers: [ErrosService],
  exports: [ErrosService],
})
export class ErrosModule {}
