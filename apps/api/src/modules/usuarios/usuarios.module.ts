import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { UsuariosController } from "./usuarios.controller"
import {
  DrizzleUsuariosRepository,
  USUARIOS_REPOSITORY,
} from "./usuarios.repository"
import { UsuariosService } from "./usuarios.service"

@Module({
  imports: [AuthModule],
  controllers: [UsuariosController],
  providers: [
    UsuariosService,
    { provide: USUARIOS_REPOSITORY, useClass: DrizzleUsuariosRepository },
  ],
  exports: [UsuariosService, USUARIOS_REPOSITORY],
})
export class UsuariosModule {}
