/**
 * GestaoTarefasGlobalFluxoModule — endpoints custom de fluxo da tarefa
 * (gestao-de-tarefas-global — macro #3, subtarefa 2).
 *
 * Registro: importado em apps/api/src/app.module.ts ANTES do CrudModule —
 * as rotas `:slug/tarefas/:id/...` são mais específicas que `:slug/:resource`
 * do CRUD e precisam ser casadas primeiro. As rotas usam 3 segmentos após o
 * slug (tarefas/:id/...), então não colidem com o CRUD de 2 segmentos; a
 * posição no AppModule garante a precedência na casagem.
 *
 * Dependências:
 * - AuthModule: fornece JwtService (via JwtModule exportado) para o
 *   JwtAuthGuard usado nos controllers deste módulo;
 * - CrudModule: fornece EscopoOrganizacaoGuard (@Global) — delegação do
 *   EscopoFluxoPorSlugGuard (tenancy intra-projeto, macro #2);
 * - PROJECT_DB_FACTORY: exportada pelo CrudModule (@Global) — banco do
 *   projeto projeto_<id>;
 * - RealtimeService: exportada pelo RealtimeModule (task.status.changed /
 *   chat.message.created — tipos já existentes em packages/shared);
 * - EscopoOrganizacaoGuard + REPOSITORIO_TENANCY: providos pelo CrudModule
 *   (@Global) — tenancy intra-projeto (macro #2).
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { CrudModule } from "../crud/crud.module"
import { RealtimeModule } from "../realtime/realtime.module"
import { FluxoTarefasGlobalController } from "./fluxo-tarefas-global.controller"
import { FluxoTarefasGlobalService } from "./fluxo-tarefas-global.service"

@Module({
  imports: [AuthModule, CrudModule, RealtimeModule],
  controllers: [FluxoTarefasGlobalController],
  providers: [FluxoTarefasGlobalService],
  exports: [FluxoTarefasGlobalService],
})
export class GestaoTarefasGlobalFluxoModule {}
