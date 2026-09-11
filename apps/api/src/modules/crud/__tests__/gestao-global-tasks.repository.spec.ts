// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { tituloTarefaErro } from "@biblioteca-global/shared"
import { GestaoGlobalTasksRepository } from "../gestao-global-tasks.repository"
import type { ProjectDbFactory } from "../project-db.factory"

interface ProjetoCaptado {
  id: number
  nome: string
  slug: string
}

interface TarefaExistente {
  id: number
  projetoId: number
  titulo: string
  descricao: string | null
}

interface Cenario {
  projeto?: ProjetoCaptado
  existente?: TarefaExistente
  idInserido?: number
}

/**
 * Fábrica falsa com o mínimo da cadeia do drizzle usada pelo repositório:
 * dois `select().from().where().limit()` (projeto captado e ocorrência ativa)
 * e um `insert().values().$returningId()`.
 */
function criarCenario(cenario: Cenario) {
  const resultados: unknown[][] = [[cenario.projeto], [cenario.existente]]
  const inseridos: Array<Record<string, unknown>> = []

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => resultados.shift() ?? [],
        }),
      }),
    }),
    insert: () => ({
      values: (valores: Record<string, unknown>) => {
        inseridos.push(valores)
        return {
          $returningId: async () =>
            cenario.idInserido === undefined ? [] : [{ id: cenario.idInserido }],
        }
      },
    }),
  }

  const factory = { obter: vi.fn(async () => db) }
  return {
    repository: new GestaoGlobalTasksRepository(
      factory as unknown as ProjectDbFactory,
    ),
    obter: factory.obter,
    inseridos,
  }
}

const PROJETO_TAQUI: ProjetoCaptado = { id: 7, nome: "TaQui", slug: "taqui" }

describe("GestaoGlobalTasksRepository — tarefas de erro", () => {
  it("mapeia o projeto da plataforma para o cadastro captado ao gravar", async () => {
    const { repository, obter, inseridos } = criarCenario({
      projeto: PROJETO_TAQUI,
      idInserido: 99,
    })

    const tarefa = await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint: "GET /api/taqui/clientes/:id",
      method: "get",
      status: 500,
      message: "Falha inesperada",
    })

    // O catálogo do Gerente de Agentes é o único database acessado — o id da
    // plataforma nunca vira database nem `tarefas.projeto_id`.
    expect(obter).toHaveBeenCalledWith({ id: 640 })
    expect(obter).not.toHaveBeenCalledWith({ id: 6611 })
    expect(inseridos).toHaveLength(1)
    expect(inseridos[0]).toMatchObject({
      projetoId: 7,
      titulo: tituloTarefaErro("GET /api/taqui/clientes/:id"),
      tipo: "verificacao",
    })
    expect(tarefa).toMatchObject({ id: 99, projetoId: 7 })
  })

  it("grava o título canônico do endpoint e não repete o método na descrição", async () => {
    const { repository, inseridos } = criarCenario({
      projeto: PROJETO_TAQUI,
      idInserido: 5,
    })

    await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint: "POST /api/taqui/clientes",
      method: "post",
      status: 400,
      message: "Coluna desconhecida: foo",
    })

    const gravado = inseridos[0] ?? {}
    expect(gravado.titulo).toBe("Erro de API: POST /api/taqui/clientes")
    const descricao = String(gravado.descricao)
    expect(descricao).toContain("Endpoint: POST /api/taqui/clientes")
    expect(descricao).not.toContain("POST POST")
    expect(descricao).toContain("Status HTTP: 400")
    expect(descricao).toContain("Projeto: TaQui (#7, plataforma #6611)")
  })

  it("prefixa o método quando o chamador envia apenas o caminho", async () => {
    const { repository, inseridos } = criarCenario({
      projeto: PROJETO_TAQUI,
      idInserido: 6,
    })

    await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint: "/api/taqui/clientes",
      method: "post",
      message: "Falha",
    })

    const gravado = inseridos[0] ?? {}
    expect(gravado.titulo).toBe("Erro de API: POST /api/taqui/clientes")
    expect(String(gravado.descricao)).toContain("Endpoint: POST /api/taqui/clientes")
  })

  it("reaproveita a ocorrência ativa do mesmo endpoint (deduplicação por deploy)", async () => {
    const existente: TarefaExistente = {
      id: 42,
      projetoId: 7,
      titulo: tituloTarefaErro("GET /api/taqui/clientes/:id"),
      descricao: "Projeto: TaQui (#7, plataforma #6611)",
    }
    const { repository, inseridos } = criarCenario({
      projeto: PROJETO_TAQUI,
      existente,
    })

    const tarefa = await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint: "GET /api/taqui/clientes/:id",
      method: "get",
      status: 500,
      message: "Falha repetida",
    })

    expect(tarefa).toEqual(existente)
    expect(inseridos).toHaveLength(0)
  })

  it("não cria tarefa quando o projeto da plataforma ainda não foi captado", async () => {
    const { repository, inseridos } = criarCenario({ projeto: undefined })

    const tarefa = await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint: "GET /api/taqui/clientes",
      method: "get",
      status: 500,
      message: "Falha",
    })

    expect(tarefa).toBeUndefined()
    expect(inseridos).toHaveLength(0)
  })

  it("trunca o título no limite de tarefas.titulo", async () => {
    const endpoint = `GET /api/taqui/${"recurso-muito-longo/".repeat(20)}:id`
    const { repository, inseridos } = criarCenario({
      projeto: PROJETO_TAQUI,
      idInserido: 8,
    })

    await repository.criarTarefaErro({
      projetoId: 6611,
      endpoint,
      method: "get",
      message: "Falha",
    })

    const titulo = String((inseridos[0] ?? {}).titulo)
    expect(titulo.length).toBeLessThanOrEqual(200)
    expect(titulo.startsWith("Erro de API: GET /api/taqui/")).toBe(true)
  })
})
