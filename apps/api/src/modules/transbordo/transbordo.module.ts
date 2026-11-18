import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { TransbordoController } from "./transbordo.controller"
import { TransbordoService } from "./transbordo.service"

@Module({
  imports: [AuthModule],
  controllers: [TransbordoController],
  providers: [TransbordoService],
  exports: [TransbordoService],
})
export class TransbordoModule {}
