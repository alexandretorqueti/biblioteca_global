/**
 * VitrinePublicaModule — endpoints públicos da vitrine (macro #10):
 * conteúdo (`GET /vitrine/conteudo`) e pedidos (`POST/GET
 * /vitrine/pedidos[...]`, posição 3/11 — subtarefa 1).
 *
 * Sem imports de auth: as rotas são públicas por construção (sem guard no
 * controller; ThrottlerGuard global protege). `CORE_DB` e
 * `PROJECT_DB_FACTORY` são globais (exportados por DatabaseModule e
 * CrudModule @Global), então o service os injeta diretamente — mesmo padrão
 * de OcorrenciasModule/HelpdeskModule. `EnvService` é provider global
 * (EnvModule) — usado pelo service de pedidos (VITRINE_DOCUMENTOS_DIR /
 * VITRINE_UPLOAD_MAX_BYTES).
 *
 * Registro: PRIMEIRO import do AppModule — rotas estáticas sob `vitrine/`
 * precisam ser descobertas antes de `:slug/:resource` do CrudModule
 * (lição verificada na subtarefa 1 da posição 2/11; manter).
 */
import { Module } from "@nestjs/common"
import { VitrinePublicaController } from "./vitrine-publica.controller"
import { VitrinePublicaService } from "./vitrine-publica.service"
import { VitrinePedidosService } from "./vitrine-pedidos.service"

@Module({
  controllers: [VitrinePublicaController],
  providers: [VitrinePublicaService, VitrinePedidosService],
  exports: [VitrinePublicaService, VitrinePedidosService],
})
export class VitrinePublicaModule {}
