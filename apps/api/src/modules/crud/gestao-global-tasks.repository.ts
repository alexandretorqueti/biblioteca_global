import { Inject, Injectable } from "@nestjs/common"
import { and, eq, notInArray } from "drizzle-orm"
import { tarefas } from "../../../../../projects/gerenteagentes/schema"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "./project-db.factory"
import { GESTAO_GLOBAL_TASKS_REPOSITORY } from "../../common/types"

/** O schema de tarefas do GestaoGlobal vive no projeto gerenteagentes. */
export const GESTAO_GLOBAL_PROJECT_ID = 640

export interface ApiErrorTaskInput {
  projetoId: number
  endpoint: string
  method?: string
  status?: number
  message: string
  details?: unknown
}

export interface ApiErrorTask {
  id: number
  projetoId: number
  titulo: string
  descricao: string | null
}

/**
 * Estes estados encerram a ocorrência. Uma nova falha do mesmo endpoint pode
 * abrir outra tarefa depois que a tarefa anterior chegou a um deles.
 * `deployada` e `finalizada` são valores legados ainda presentes na base.
 */
const STATUS_QUE_PERMITEM_NOVA_OCORRENCIA = [
  "ready",
  "completed",
  "deployed",
  "finalizada",
  "deployada",
] as const

/** Persistência das tarefas de erro no schema do GestaoGlobal. */
@Injectable()
export class GestaoGlobalTasksRepository {
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  private async db() {
    // A seleção do database é fixa e feita pela fábrica; nunca vem do request.
    return this.factory.obter({ id: GESTAO_GLOBAL_PROJECT_ID })
  }

  private tituloDoErro(endpoint: string): string {
    return `Erro de API: ${endpoint}`
  }

  /** Consulta somente uma ocorrência ainda ativa no projeto informado. */
  async encontrarPorEndpoint(endpoint: string, projetoId: number) {
    const titulo = this.tituloDoErro(endpoint)
    const resultado = await (await this.db())
      .select({
        id: tarefas.id,
        projetoId: tarefas.projetoId,
        titulo: tarefas.titulo,
        descricao: tarefas.descricao,
      })
      .from(tarefas)
      .where(and(
        eq(tarefas.projetoId, projetoId),
        eq(tarefas.titulo, titulo),
        notInArray(tarefas.status, [...STATUS_QUE_PERMITEM_NOVA_OCORRENCIA]),
      ))
      .limit(1)
    return resultado[0]
  }

  /**
   * Cria uma tarefa para a ocorrência, mantendo uma única ocorrência ativa por
   * endpoint e projeto. Ocorrências concluídas não bloqueiam novas criações.
   */
  async criarTarefaErro(input: ApiErrorTaskInput): Promise<ApiErrorTask | undefined> {
    const method = input.method ?? "HTTP"
    const existente = await this.encontrarPorEndpoint(input.endpoint, input.projetoId)
    if (existente) return existente

    const descricao = [
      `Projeto ativo: ${input.projetoId}`,
      `Endpoint: ${method.toUpperCase()} ${input.endpoint}`,
      input.status === undefined ? undefined : `Status HTTP: ${input.status}`,
      `Mensagem: ${input.message}`,
      input.details === undefined ? undefined : `Detalhes: ${JSON.stringify(input.details)}`,
    ].filter((parte): parte is string => parte !== undefined).join("\n")

    const inserida = await (await this.db())
      .insert(tarefas)
      .values({
        projetoId: input.projetoId,
        titulo: this.tituloDoErro(input.endpoint),
        descricao,
        tipo: "verificacao",
        status: "planned",
      })
      .$returningId()
    const id = inserida[0]?.id
    if (id === undefined) return undefined
    return {
      id,
      projetoId: input.projetoId,
      titulo: this.tituloDoErro(input.endpoint),
      descricao,
    }
  }

  // Alias semântico para consumidores que tratam o método como upsert idempotente.
  async registrarErro(input: ApiErrorTaskInput): Promise<ApiErrorTask | undefined> {
    return this.criarTarefaErro(input)
  }
}

export { GESTAO_GLOBAL_TASKS_REPOSITORY }
