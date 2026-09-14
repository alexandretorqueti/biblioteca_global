import { Module } from "@nestjs/common"
import { LgpdController } from "./lgpd.controller"
import { LgpdService } from "./lgpd.service"
import { AcessoDadosController } from "./acesso-dados.controller"
import { AcessoDadosService } from "./acesso-dados.service"
import { AcessoDadosInterceptor } from "./acesso-dados.interceptor"
import {
  DrizzleLgpdRepository,
  LGPD_REPOSITORY,
} from "./lgpd.repository"

@Module({
  controllers: [LgpdController, AcessoDadosController],
  providers: [
    LgpdService,
    AcessoDadosService,
    AcessoDadosInterceptor,
    { provide: LGPD_REPOSITORY, useClass: DrizzleLgpdRepository },
  ],
})
export class LgpdModule {}
