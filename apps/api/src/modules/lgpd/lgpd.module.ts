import { Module } from "@nestjs/common"
import { LgpdController } from "./lgpd.controller"
import { LgpdService } from "./lgpd.service"
import {
  DrizzleLgpdRepository,
  LGPD_REPOSITORY,
} from "./lgpd.repository"

@Module({
  controllers: [LgpdController],
  providers: [
    LgpdService,
    { provide: LGPD_REPOSITORY, useClass: DrizzleLgpdRepository },
  ],
})
export class LgpdModule {}
