/**
 * GestaoTarefasGlobalVisoesModule — visões por área e por categoria (tags)
 * (gestao-de-tarefas-global — macro #8, subtarefa 1; REQ-F-004).
 *
 * Registro: importado em apps/api/src/app.module.ts ANTES do CrudModule —
 * as rotas `:slug/visoes/...` (2 segmentos) precisam ser casadas antes do
 * CRUD `:slug/:resource/:id`, que interpretaria `visoes` como resource.
 *
 * Dependências:
 * - AuthModule: JwtService (via JwtModule) para o JwtAuthGuard;
 * - CrudModule: PROJECT_DB_FACTORY (@Global) — banco projeto_<id> — e
 *   EscopoOrganizacaoGuard (@Global) — delegação do EscopoVisoesPorSlugGuard;
 * - Sem realtime/notificações: endpoints são SOMENTE LEITURA (nenhum
 *   evento publicado).
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { CrudModule } from "../crud/crud.module"
import { VisoesTarefasGlobalController } from "./visoes-tarefas-global.controller"
import { VisoesTarefasGlobalService } from "./visoes-tarefas-global.service"

@Module({
  imports: [AuthModule, CrudModule],
  controllers: [VisoesTarefasGlobalController],
  providers: [VisoesTarefasGlobalService],
  exports: [VisoesTarefasGlobalService],
})
export class GestaoTarefasGlobalVisoesModule {}
