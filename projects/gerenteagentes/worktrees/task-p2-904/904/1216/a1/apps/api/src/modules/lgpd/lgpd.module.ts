import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { LgpdController } from "./lgpd.controller"
import { LgpdService } from "./lgpd.service"
import { AcessoDadosController } from "./acesso-dados.controller"
import { AcessoDadosService } from "./acesso-dados.service"
import { AcessoDadosInterceptor } from "./acesso-dados.interceptor"
import { RetencaoController } from "./retencao.controller"
import { RetencaoService } from "./retencao.service"
import { DrizzleRetencaoRepository, RETENCAO_REPOSITORY } from "./retencao.repository"
import {
  DrizzleLgpdRepository,
  LGPD_REPOSITORY,
} from "./lgpd.repository"

@Module({
  imports: [AuthModule],
  controllers: [LgpdController, AcessoDadosController, RetencaoController],
  providers: [
    LgpdService,
    AcessoDadosService,
    AcessoDadosInterceptor,
    RetencaoService,
    { provide: RETENCAO_REPOSITORY, useClass: DrizzleRetencaoRepository },
    { provide: LGPD_REPOSITORY, useClass: DrizzleLgpdRepository },
  ],
})
export class LgpdModule {}
