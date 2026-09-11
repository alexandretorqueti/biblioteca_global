import { Inject, Injectable, Logger } from "@nestjs/common"
import { and, eq, sql } from "drizzle-orm"
import { tituloTarefaErro } from "@biblioteca-global/shared"
import {
  projetosCaptados,
  tarefas,
} from "../../../../../projects/gerenteagentes/schema"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "./project-db.factory"
import { GESTAO_GLOBAL_TASKS_REPOSITORY } from "../../common/types"

/** O schema de tarefas do GestaoGlobal vive no projeto gerenteagentes. */
export const GESTAO_GLOBAL_PROJECT_ID = 640

export interface ApiErrorTaskInput {
  /**
   * ID do projeto da PLATAFORMA (escopo do token — PoC §5.3). Nunca é usado
   * como `tarefas.projeto_id`: o repositório traduz para o cadastro captado
   * do catálogo do Gerente de Agentes (ver `resolverProjetoCaptado`).
   */
  projetoId: number
  /** Chave canônica do endpoint (`montarEndpointCanonico`, subtarefa 2). */
  endpoint: string
  /**
   * Método HTTP. Redundante com a chave canônica — permanece apenas como
   * rede de proteção para chamadas que enviem o caminho sem método.
   */
  method?: string
  status?: number
  message: string
  details?: unknown
}

/** Projeto captado no catálogo do Gerente de Agentes (fonte de `tarefas`). */
export interface ProjetoCaptadoResumo {
  id: number
  nome: string
  slug: string
}

export interface ApiErrorTask {
  id: number
  /** ID do projeto no catálogo do Gerente de Agentes (`projetos_captados.id`). */
  projetoId: number
  titulo: string
  descricao: string | null
}

/**
 * Estes estados encerram a ocorrência. Uma nova falha do mesmo endpoint pode
 * abrir outra tarefa depois que a tarefa anterior chegou a um deles.
 * `deployada` e `finalizada` são valores legados ainda presentes na base.
 */
const STATUS_TERMINAIS = ["cancelled", "failed", "motor_fix"] as const

/** Persistência das tarefas de erro no schema do GestaoGlobal. */
@Injectable()
export class GestaoGlobalTasksRepository {
  private readonly logger = new Logger(GestaoGlobalTasksRepository.name)

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  private async db() {
    // A seleção do database é fixa e feita pela fábrica; nunca vem do request.
    return this.factory.obter({ id: GESTAO_GLOBAL_PROJECT_ID })
  }

  /**
   * Mapeamento de projeto: o request carrega o ID do projeto da plataforma
   * (ex.: TaQui = 6611), mas `tarefas` e `projetos_captados` vivem no catálogo
   * do Gerente de Agentes (projeto_640) e `tarefas.projeto_id` referencia
   * `projetos_captados.id`. Sem esta tradução o insert viola a FK e a
   * deduplicação nunca casa (compararia o id errado).
   *
   * Mesmo vínculo usado pelo HelpDesk (`plataforma_projeto_id`).
   */
  async resolverProjetoCaptado(
    plataformaProjetoId: number,
  ): Promise<ProjetoCaptadoResumo | undefined> {
    const [projeto] = await (await this.db())
      .select({
        id: projetosCaptados.id,
        nome: projetosCaptados.nome,
        slug: projetosCaptados.slug,
      })
      .from(projetosCaptados)
      .where(eq(projetosCaptados.plataformaProjetoId, plataformaProjetoId))
      .limit(1)
    return projeto
  }

  /**
   * Chave canônica pronta para o título e a deduplicação. O endpoint já vem
   * canônico do filtro/relato; o método só é prefixado quando o chamador
   * envia o caminho cru (defesa contra título e dedup divergentes).
   */
  private endpointCanonico(input: ApiErrorTaskInput): string {
    const endpoint = input.endpoint.trim()
    const metodo = (input.method ?? "").trim().toUpperCase()
    if (metodo === "" || endpoint.toUpperCase().startsWith(`${metodo} `)) {
      return endpoint
    }
    return `${metodo} ${endpoint}`
  }

  private descricaoDoErro(
    input: ApiErrorTaskInput,
    endpoint: string,
    projeto: ProjetoCaptadoResumo,
  ): string {
    return [
      `Projeto: ${projeto.nome} (#${projeto.id}, plataforma #${input.projetoId})`,
      `Endpoint: ${endpoint}`,
      input.status === undefined ? undefined : `Status HTTP: ${input.status}`,
      `Mensagem: ${input.message}`,
      input.details === undefined ? undefined : `Detalhes: ${JSON.stringify(input.details)}`,
    ].filter((parte): parte is string => parte !== undefined).join("\n")
  }

  /**
   * Consulta somente uma ocorrência ainda ativa no projeto informado
   * (`projetos_captados.id`).
   *
   * Deduplicação por deploy: a ocorrência deixa de bloquear novas tarefas do
   * mesmo endpoint quando o defeito já foi publicado — fato registrado em
   * `deploy_requests` (`status = 'succeeded'`), que é o mesmo critério usado
   * pelo gate de promoção do Motor. Enquanto não há deploy, a primeira tarefa
   * criada continua representando o endpoint; sem ela, cada requisição
   * falhando abriria uma tarefa nova.
   */
  async encontrarPorEndpoint(endpoint: string, projetoId: number) {
    const titulo = tituloTarefaErro(endpoint)
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
        // O status materializado foi removido de `tarefas`. A tarefa ativa é
        // identificada pelos fatos operacionais, que são a fonte de verdade.
        sql`NOT EXISTS (
          SELECT 1 FROM task_runtime_facts f
          WHERE f.tarefa_id = ${tarefas.id}
            AND (
              f.terminal_status IN (${sql.join(STATUS_TERMINAIS.map((status) => sql`${status}`), sql`, `)})
              OR (
                f.integration_confirmed_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = ${tarefas.id})
                AND NOT EXISTS (
                  SELECT 1 FROM subtarefas s
                  WHERE s.tarefa_id = ${tarefas.id}
                    AND s.status NOT IN ('verified', 'superseded')
                )
              )
              OR EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = ${tarefas.id} AND d.status = 'succeeded')
            )
        )`,
      ))
      .limit(1)
    return resultado[0]
  }

  /**
   * Cria uma tarefa para a ocorrência, mantendo uma única ocorrência ativa por
   * endpoint e projeto. Ocorrências concluídas (inclusive por deploy) não
   * bloqueiam novas criações.
   *
   * Retorna `undefined` quando o projeto da plataforma ainda não foi captado
   * no catálogo — sem `projetos_captados` não há FK válida para `tarefas`.
   */
  async criarTarefaErro(input: ApiErrorTaskInput): Promise<ApiErrorTask | undefined> {
    const projeto = await this.resolverProjetoCaptado(input.projetoId)
    if (!projeto) {
      this.logger.warn(
        `Projeto da plataforma ${input.projetoId} não está cadastrado em projetos_captados; a ocorrência não virou tarefa`,
      )
      return undefined
    }

    const endpoint = this.endpointCanonico(input)
    const titulo = tituloTarefaErro(endpoint)
    const existente = await this.encontrarPorEndpoint(endpoint, projeto.id)
    if (existente) return existente

    const descricao = this.descricaoDoErro(input, endpoint, projeto)

    const inserida = await (await this.db())
      .insert(tarefas)
      .values({
        projetoId: projeto.id,
        titulo,
        descricao,
        tipo: "verificacao",
      })
      .$returningId()
    const id = inserida[0]?.id
    if (id === undefined) return undefined
    return { id, projetoId: projeto.id, titulo, descricao }
  }

  // Alias semântico para consumidores que tratam o método como upsert idempotente.
  async registrarErro(input: ApiErrorTaskInput): Promise<ApiErrorTask | undefined> {
    return this.criarTarefaErro(input)
  }
}

export { GESTAO_GLOBAL_TASKS_REPOSITORY }
