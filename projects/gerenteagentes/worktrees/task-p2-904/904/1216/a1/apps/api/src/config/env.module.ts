import { Global, Module } from "@nestjs/common"
import { EnvService } from "./env.service"

/** Ambiente tipado disponível para todos os módulos. */
@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
