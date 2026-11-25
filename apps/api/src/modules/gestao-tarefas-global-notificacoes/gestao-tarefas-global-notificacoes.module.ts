/**
 * GestaoTarefasGlobalNotificacoesModule — motor de lembretes + sino
 * in-app (gestao-de-tarefas-global — macro #5, subtarefas 1 e 2).
 *
 * Subtarefa 1: agendador periódico com timer (padrão dos reconcilers —
 * `CanaisWhatsappReconciler`); o timer é `.unref()` e o flag env
 * `GESTAO_TAREFAS_LEMBRETE_SCHEDULER=0` desliga o agendador.
 *
 * Subtarefa 2: NotificacoesService (criação atômica na transação do
 * chamador + push `notification.created`/`notifications.unread.changed`
 * pós-commit via RealtimeService) e o controller do sino
 * (`GET/POST :slug/notificacoes...` — sempre restrito ao usuário da
 * sessão). Registro em app.module ANTES do CrudModule (rotas de 3+ segmentos
 * após o slug precisam casar antes do CRUD genérico).
 *
 * Exporta NotificacoesService para o módulo de fluxo (notificações de
 * delegação/devolução criadas na MESMA transição de estado).
 *
 * Dependências:
 * - CrudModule (@Global): fornece PROJECT_DB_FACTORY (banco do projeto
 *   `projeto_<id>`) e a tenancy do projeto;
 * - AuthModule: JwtService para o JwtAuthGuard do controller;
 * - RealtimeModule: RealtimeService (canal `notifications`, subtarefa 3);
 * - DatabaseModule (@Global): CORE_DB — resolução do id do projeto por slug
 *   no core (padrão GestaoOrganizacoesService).
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { CrudModule } from "../crud/crud.module"
import { RealtimeModule } from "../realtime/realtime.module"
import { NotificacoesController } from "./notificacoes.controller"
import { NotificacoesService } from "./notificacoes.service"
import { LembreteAgendadorService } from "./lembrete-agendador.service"
import {
  LEMBRETE_AGENDADOR_REPOSITORIO,
  LembreteAgendadorRepositorio,
} from "./lembrete-agendador.repositorio"

@Module({
  imports: [AuthModule, CrudModule, RealtimeModule],
  controllers: [NotificacoesController],
  providers: [
    LembreteAgendadorService,
    {
      provide: LEMBRETE_AGENDADOR_REPOSITORIO,
      useClass: LembreteAgendadorRepositorio,
    },
    NotificacoesService,
  ],
  exports: [LembreteAgendadorService, NotificacoesService],
})
export class GestaoTarefasGlobalNotificacoesModule {}
