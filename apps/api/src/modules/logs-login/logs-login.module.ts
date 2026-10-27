import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { LogsLoginController } from "./logs-login.controller"
import {
  DrizzleLogsLoginRepository,
  LOGS_LOGIN_REPOSITORY,
} from "./logs-login.repository"
import { LogsLoginService } from "./logs-login.service"

@Module({
  imports: [AuthModule],
  controllers: [LogsLoginController],
  providers: [
    LogsLoginService,
    { provide: LOGS_LOGIN_REPOSITORY, useClass: DrizzleLogsLoginRepository },
  ],
})
export class LogsLoginModule {}
