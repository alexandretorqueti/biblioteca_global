/**
 * VitrinePublicaModule — endpoint público do conteúdo da vitrine
 * (macro #10, posição 2/11 — subtarefa 1).
 *
 * Sem imports de auth: a rota é pública por construção (sem guard no
 * controller; ThrottlerGuard global protege). `CORE_DB` e
 * `PROJECT_DB_FACTORY` são globais (exportados por DatabaseModule e
 * CrudModule @Global), então o service os injeta diretamente — mesmo padrão
 * de OcorrenciasModule/HelpdeskModule.
 */
import { Module } from "@nestjs/common"
import { VitrinePublicaController } from "./vitrine-publica.controller"
import { VitrinePublicaService } from "./vitrine-publica.service"

@Module({
  controllers: [VitrinePublicaController],
  providers: [VitrinePublicaService],
  exports: [VitrinePublicaService],
})
export class VitrinePublicaModule {}
