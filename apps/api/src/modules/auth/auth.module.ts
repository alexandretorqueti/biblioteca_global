import { Module } from "@nestjs/common"
import { JwtModule } from "@nestjs/jwt"
import { EnvService } from "../../config/env.service"
import { AuthController } from "./auth.controller"
import {
  AUTH_REPOSITORY,
  DrizzleAuthRepository,
} from "./auth.repository"
import { AuthService } from "./auth.service"

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({ secret: env.jwtSecret }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: AUTH_REPOSITORY, useClass: DrizzleAuthRepository },
  ],
  exports: [AuthService, AUTH_REPOSITORY, JwtModule],
})
export class AuthModule {}
