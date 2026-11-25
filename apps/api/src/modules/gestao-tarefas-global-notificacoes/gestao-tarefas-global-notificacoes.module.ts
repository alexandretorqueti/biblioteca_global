/**
 * GestaoTarefasGlobalNotificacoesModule — agendador periódico do motor de
 * lembretes (gestao-de-tarefas-global — macro #5, subtarefa 1).
 *
 * Sem controller/rotas (sino/endpoints = subtarefa 3): apenas o service com
 * timer (padrão dos reconcilers — `CanaisWhatsappReconciler`) replicando o
 * módulo de recorrência (macro 4, subtarefa 3). O timer é `.unref()` e o
 * flag env `GESTAO_TAREFAS_LEMBRETE_SCHEDULER=0` desliga o agendador.
 *
 * Dependências:
 * - CrudModule (@Global): fornece PROJECT_DB_FACTORY (banco do projeto
 *   `projeto_<id>`) e a tenancy do projeto;
 * - DatabaseModule (@Global): CORE_DB — resolução do id do projeto por slug
 *   no core (padrão GestaoOrganizacoesService).
 */
import { Module } from "@nestjs/common"
import { CrudModule } from "../crud/crud.module"
import { LembreteAgendadorService } from "./lembrete-agendador.service"
import {
  LEMBRETE_AGENDADOR_REPOSITORIO,
  LembreteAgendadorRepositorio,
} from "./lembrete-agendador.repositorio"

@Module({
  imports: [CrudModule],
  providers: [
    LembreteAgendadorService,
    {
      provide: LEMBRETE_AGENDADOR_REPOSITORIO,
      useClass: LembreteAgendadorRepositorio,
    },
  ],
  exports: [LembreteAgendadorService],
})
export class GestaoTarefasGlobalNotificacoesModule {}
