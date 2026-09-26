/**
 * ProvisionModule — acesso automático de clientes a projetos (auth única, D6).
 * O GerenteAgentes chama POST /provision/project com o token de serviço.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { ProjetosModule } from "../projetos/projetos.module"
import { UsuariosModule } from "../usuarios/usuarios.module"
import { ProvisionController } from "./provision.controller"
import { ProvisionService } from "./provision.service"

@Module({
  imports: [AuthModule, UsuariosModule, ProjetosModule],
  controllers: [ProvisionController],
  providers: [ProvisionService],
  exports: [ProvisionService],
})
export class ProvisionModule {}
