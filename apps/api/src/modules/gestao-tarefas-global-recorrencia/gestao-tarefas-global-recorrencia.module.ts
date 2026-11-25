/**
 * GestaoTarefasGlobalRecorrenciaModule — agendador periódico do motor de
 * recorrência (gestao-de-tarefas-global — macro #4, subtarefa 3).
 *
 * Sem controller/rotas: apenas o service com timer (padrão dos reconcilers —
 * `CanaisWhatsappReconciler`). O timer é `.unref()` e o flag env
 * `GESTAO_TAREFAS_RECORRENCIA_SCHEDULER=0` desliga o agendador.
 *
 * Dependências:
 * - CrudModule (@Global): fornece PROJECT_DB_FACTORY (banco do projeto
 *   `projeto_<id>`) e a tenancy do projeto;
 * - DatabaseModule (@Global): CORE_DB — resolução do id do projeto por slug
 *   no core (padrão GestaoOrganizacoesService).
 */
import { Module } from "@nestjs/common"
import { CrudModule } from "../crud/crud.module"
import { RecorrenciaAgendadorService } from "./recorrencia-agendador.service"
import {
  RECURRENCIA_AGENDADOR_REPOSITORIO,
  RecorrenciaAgendadorRepositorio,
} from "./recorrencia-agendador.repositorio"

@Module({
  imports: [CrudModule],
  providers: [
    RecorrenciaAgendadorService,
    {
      provide: RECURRENCIA_AGENDADOR_REPOSITORIO,
      useClass: RecorrenciaAgendadorRepositorio,
    },
  ],
  exports: [RecorrenciaAgendadorService],
})
export class GestaoTarefasGlobalRecorrenciaModule {}
