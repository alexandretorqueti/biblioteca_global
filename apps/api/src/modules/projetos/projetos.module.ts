import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { CrudModule } from "../crud/crud.module"
import { ProjetosController } from "./projetos.controller"
import {
  DrizzleProjetoProvisioner,
  PROJETO_PROVISIONER,
} from "./provisioner.service"
import {
  DrizzleProjetosRepository,
  PROJETOS_REPOSITORY,
} from "./projetos.repository"
import { ProjetosService } from "./projetos.service"

@Module({
  imports: [AuthModule, CrudModule],
  controllers: [ProjetosController],
  providers: [
    ProjetosService,
    { provide: PROJETOS_REPOSITORY, useClass: DrizzleProjetosRepository },
    { provide: PROJETO_PROVISIONER, useClass: DrizzleProjetoProvisioner },
  ],
  exports: [ProjetosService, PROJETO_PROVISIONER],
})
export class ProjetosModule {}
