import { Inject, Injectable } from "@nestjs/common"
import {
  erroReportavel,
  type ErrorReportRequest,
  type ErrorReportResult,
} from "@biblioteca-global/shared"
import {
  GESTAO_GLOBAL_TASKS_REPOSITORY,
} from "../../common/types"

interface ErrorTaskRepository {
  criarTarefaErro(input: {
    projetoId: number
    endpoint: string
    method?: string
    status?: number
    message: string
    details?: unknown
  }): Promise<{ id: number } | undefined>
}

function mensagemDoRelato(relato: ErrorReportRequest): string {
  if (relato.error?.message) return relato.error.message
  if (typeof relato.responseBody === "string" && relato.responseBody.trim() !== "") {
    return relato.responseBody
  }
  return relato.error?.name ?? `Falha ao chamar ${relato.endpoint}`
}

@Injectable()
export class ErrosService {
  constructor(
    @Inject(GESTAO_GLOBAL_TASKS_REPOSITORY)
    private readonly tasksRepository: ErrorTaskRepository,
  ) {}

  async registrar(
    projetoId: number,
    relato: ErrorReportRequest,
  ): Promise<ErrorReportResult> {
    const decisao = erroReportavel({
      status: relato.responseStatus,
      code: relato.error?.code,
      origem: relato.origem,
    })
    if (!decisao.reportavel) {
      return { registrada: false, motivo: decisao.motivo }
    }

    const tarefa = await this.tasksRepository.criarTarefaErro({
      projetoId,
      endpoint: relato.endpoint,
      status: relato.responseStatus ?? undefined,
      message: mensagemDoRelato(relato),
      // O repositório mantém a descrição legível; o relato integral fica aqui
      // para preservar usuário, tela, origem, request e resposta do endpoint.
      details: { relato, motivo: decisao.motivo },
    })

    if (!tarefa) {
      return {
        registrada: false,
        motivo: "Projeto ainda não cadastrado no catálogo de tarefas",
      }
    }
    return { registrada: true, tarefaId: tarefa.id }
  }
}
