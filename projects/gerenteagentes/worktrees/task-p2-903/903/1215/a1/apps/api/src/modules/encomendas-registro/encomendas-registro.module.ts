/**
 * EncomendasRegistroModule — endpoints customizados para registro rápido
 * de encomendas no fluxo da portaria.
 *
 * Importa AuthModule (para guards) e registra controller + service.
 * O ProjectDbFactory é global (exportado pelo CrudModule), então o service
 * pode injetá-lo diretamente.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { EncomendasRegistroController } from "./encomendas-registro.controller"
import { EncomendasRegistroService } from "./encomendas-registro.service"

@Module({
  imports: [AuthModule],
  controllers: [EncomendasRegistroController],
  providers: [EncomendasRegistroService],
  exports: [EncomendasRegistroService],
})
export class EncomendasRegistroModule {}
