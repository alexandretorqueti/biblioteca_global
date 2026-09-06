/**
 * EncomendasMoradorModule — endpoints para o morador visualizar e confirmar
 * suas encomendas.
 *
 * Importa AuthModule (para guards) e registra controller + service.
 * O ProjectDbFactory é global (exportado pelo CrudModule), então o service
 * pode injetá-lo diretamente.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { EncomendasMoradorController } from "./encomendas-morador.controller"
import { EncomendasMoradorService } from "./encomendas-morador.service"

@Module({
  imports: [AuthModule],
  controllers: [EncomendasMoradorController],
  providers: [EncomendasMoradorService],
  exports: [EncomendasMoradorService],
})
export class EncomendasMoradorModule {}
