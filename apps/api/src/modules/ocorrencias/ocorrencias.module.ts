/**
 * OcorrenciasModule — endpoints para registro e consulta de ocorrências/devoluções.
 *
 * Importa AuthModule (para guards) e registra controller + service.
 * O ProjectDbFactory é global (exportado pelo CrudModule), então o service
 * pode injetá-lo diretamente.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { OcorrenciasController } from "./ocorrencias.controller"
import { OcorrenciasService } from "./ocorrencias.service"

@Module({
  imports: [AuthModule],
  controllers: [OcorrenciasController],
  providers: [OcorrenciasService],
  exports: [OcorrenciasService],
})
export class OcorrenciasModule {}
