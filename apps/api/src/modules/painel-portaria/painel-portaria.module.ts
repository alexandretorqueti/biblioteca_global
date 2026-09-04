/**
 * PainelPortariaModule — endpoints do painel da portaria.
 *
 * Importa AuthModule (para guards) e registra controller + service.
 * O ProjectDbFactory é global (exportado pelo CrudModule), então o service
 * pode injetá-lo diretamente.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { PainelPortariaController } from "./painel-portaria.controller"
import { PainelPortariaService } from "./painel-portaria.service"

@Module({
  imports: [AuthModule],
  controllers: [PainelPortariaController],
  providers: [PainelPortariaService],
  exports: [PainelPortariaService],
})
export class PainelPortariaModule {}
