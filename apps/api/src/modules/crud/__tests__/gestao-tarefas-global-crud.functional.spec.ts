// @vitest-environment node
/**
 * Teste funcional do CRUD genérico namespaced do projeto
 * gestao-de-tarefas-global (plano macro #1, subtarefa 2) — API real + MySQL
 * real (core + projeto_8496). Requer MYSQL_HOST no ambiente e o projeto
 * provisionado (migrations aplicadas + config corrente + ativo).
 *
 * Cobre o critério de aceite: listar/buscar/filtrar/ordenar/criar/editar/
 * excluir via /api/gestao-de-tarefas-global/<resource> para areas, tags,
 * colaboradores, tarefas e regras_recorrencia (organizacoes como apoio/FK).
 *
 * O usuário de teste (teste_crud_gtg) e todas as linhas de negócio criadas
 * são removidos ao final (FK-order), sem tocar em dados de outros projetos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import argon2 from "argon2"
import { eq } from "drizzle-orm"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"

const USUARIO_TESTE = "teste_crud_gtg"
const SENHA_TESTE = "CrudGtg#2026"
const SUFIXO = `e2e-${Date.now()}`
const SLUG = "gestao-de-tarefas-global"
const hasMysql = Boolean(process.env.MYSQL_HOST)

describe.skipIf(!hasMysql)("CRUD namespaced — gestao-de-tarefas-global (funcional)", () => {
  let app: INestApplication
  let db: CoreDb
  let accessToken: string
  let projetoId: number

  // ids criados (limpeza em ordem inversa de FK)
  const ids: {
    organizacao?: number
    colaborador?: number
    area?: number
    tag?: number
    regra?: number
    tarefa?: number
  } = {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    db = app.get<CoreDb>(CORE_DB)

    const projeto = (
      await db.select({ id: projetos.id }).from(projetos).where(eq(projetos.slug, SLUG))
    ).at(0)
    if (!projeto) throw new Error(`pré-requisito ausente: projeto ${SLUG} no core`)
    projetoId = projeto.id

    // Usuário de teste (limpa resíduo de execuções anteriores) + vínculo admin.
    await limparUsuarioTeste()
    const hash = await argon2.hash(SENHA_TESTE, { type: argon2.argon2id })
    await db.insert(usuarios).values({
      username: USUARIO_TESTE,
      email: `${USUARIO_TESTE}@exemplo.com`,
      nome: "Usuário E2E CRUD",
      passwordHash: hash,
      ativo: true,
    })
    const usuario = (
      await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, USUARIO_TESTE))
    ).at(0)
    if (!usuario) throw new Error("usuário de teste não criado")
    await db.insert(projetosUsuarios).values({
      projetoId,
      usuarioId: usuario.id,
      perfil: "admin",
    })

    // login → select-project → access token do projeto.
    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ identifier: USUARIO_TESTE, password: SENHA_TESTE, identifierType: "username", consentimentoAceito: true })
    expect(login.status).toBe(201)
    const select = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${login.body.refreshToken}`)
      .send({ projetoId })
    expect(select.status).toBe(201)
    accessToken = select.body.accessToken as string
    expect(accessToken).toBeTruthy()
  }, 90_000)

  afterAll(async () => {
    if (app) {
      await apagarSobras()
      await limparUsuarioTeste()
      await app.close()
    }
  }, 60_000)

  function api(method: "get" | "post" | "put" | "delete", path: string, body?: Record<string, unknown>) {
    const req = request(app.getHttpServer())[method](`/api/${SLUG}/${path}`)
    const autenticado = req.set("Authorization", `Bearer ${accessToken}`)
    return body !== undefined ? autenticado.send(body) : autenticado
  }

  async function usuarioTesteId(): Promise<number | undefined> {
    return (
      await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, USUARIO_TESTE))
    ).at(0)?.id
  }

  async function limparUsuarioTeste(): Promise<void> {
    const id = await usuarioTesteId()
    if (!id) return
    await db.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, id))
    await db.delete(usuarios).where(eq(usuarios.id, id))
  }

  /** Remove linhas de negócio residuais (falha no meio do fluxo) via API. */
  async function apagarSobras(): Promise<void> {
    const ordem: Array<[string, keyof typeof ids]> = [
      ["tarefas", "tarefa"],
      ["regras_recorrencia", "regra"],
      ["tags", "tag"],
      ["areas", "area"],
      ["colaboradores", "colaborador"],
      ["organizacoes", "organizacao"],
    ]
    for (const [resource, chave] of ordem) {
      const id = ids[chave]
      if (!id) continue
      try {
        await api("delete", `${resource}/${id}`)
      } catch {
        // melhor esforço
      }
    }
  }

  it("criar: organização → colaborador → área (líder = responsável) → tag", async () => {
    const org = await api("post", "organizacoes", {
      nome: `Organização ${SUFIXO}`,
      descricao: "organização do teste e2e",
    })
    expect([200, 201]).toContain(org.status)
    ids.organizacao = Number(org.body.id)
    expect(ids.organizacao).toBeGreaterThan(0)

    const colab = await api("post", "colaboradores", {
      organizacao_id: ids.organizacao,
      nome: "Maria E2E da Silva",
      email: `maria.${SUFIXO}@exemplo.com`,
      telefone: "(11) 91234-5678",
      cpf: "123.456.789-09",
    })
    expect([200, 201]).toContain(colab.status)
    ids.colaborador = Number(colab.body.id)
    expect(colab.body.nome).toBe("Maria E2E da Silva")

    // Líder cadastrável como responsável de área (critério de aceite da macro).
    const area = await api("post", "areas", {
      organizacao_id: ids.organizacao,
      nome: `Área ${SUFIXO}`,
      responsavel_id: ids.colaborador,
    })
    expect([200, 201]).toContain(area.status)
    ids.area = Number(area.body.id)
    expect(Number(area.body.responsavelId)).toBe(ids.colaborador)

    const tag = await api("post", "tags", {
      organizacao_id: ids.organizacao,
      nome: `tag-${SUFIXO}`,
    })
    expect([200, 201]).toContain(tag.status)
    ids.tag = Number(tag.body.id)
  })

  it("criar: regra de recorrência e tarefa (FKs + enums + datetime)", async () => {
    const regra = await api("post", "regras_recorrencia", {
      organizacao_id: ids.organizacao,
      titulo: `Recorrência ${SUFIXO}`,
      area_id: ids.area,
      responsavel_id: ids.colaborador,
      frequencia: "semanal",
      dias_semana: [1, 3],
      hora_do_dia: "09:00:00",
      data_inicio: "2026-11-10",
    })
    expect([200, 201]).toContain(regra.status)
    ids.regra = Number(regra.body.id)
    expect(regra.body.frequencia).toBe("semanal")

    const tarefa = await api("post", "tarefas", {
      organizacao_id: ids.organizacao,
      titulo: `Tarefa ${SUFIXO}`,
      descricao: "criada pelo teste funcional",
      area_id: ids.area,
      responsavel_id: ids.colaborador,
      criado_por_id: ids.colaborador,
      prioridade: "alta",
      prazo: "2026-12-01 10:00:00",
      regra_recorrencia_id: ids.regra,
    })
    if (![200, 201].includes(tarefa.status)) {
      console.log("POST tarefas →", tarefa.status, JSON.stringify(tarefa.body))
    }
    expect([200, 201]).toContain(tarefa.status)
    ids.tarefa = Number(tarefa.body.id)
    expect(tarefa.body.prioridade).toBe("alta")
    expect(tarefa.body.status).toBe("aberta") // default do schema
  })

  it("listar com paginação + buscar (search) nas tarefas", async () => {
    const lista = await api("get", "tarefas?page=1&pageSize=10")
    expect(lista.status).toBe(200)
    expect(lista.body).toHaveProperty("items")
    expect(lista.body).toHaveProperty("total")
    expect(lista.body.page).toBe(1)

    const busca = await api("get", `tarefas?search=${encodeURIComponent(SUFIXO)}`)
    expect(busca.status).toBe(200)
    const encontrados = (busca.body.items as Array<{ id: number }>).map((i) => i.id)
    expect(encontrados).toContain(ids.tarefa)
  })

  it("filtrar por FK (query camelCase) e ordenar", async () => {
    const filtrada = await api(
      "get",
      `colaboradores?organizacaoId=${ids.organizacao}`,
    )
    expect(filtrada.status).toBe(200)
    expect((filtrada.body.items as Array<{ id: number }>).map((i) => i.id)).toContain(
      ids.colaborador,
    )

    const ordenada = await api("get", "areas?orderBy=nome:desc&pageSize=100")
    expect(ordenada.status).toBe(200)
    const nomes = (ordenada.body.items as Array<{ nome: string }>).map((i) => i.nome)
    expect(nomes).toEqual([...nomes].sort((a, b) => b.localeCompare(a)))
  })

  it("detalhar e editar (PUT) tarefa", async () => {
    const detalhe = await api("get", `tarefas/${ids.tarefa}`)
    expect(detalhe.status).toBe(200)
    expect(detalhe.body.titulo).toContain(SUFIXO)

    const novoTitulo = `Tarefa editada ${SUFIXO}`
    const editada = await api("put", `tarefas/${ids.tarefa}`, { titulo: novoTitulo })
    expect(editada.status).toBe(200)
    expect(editada.body.titulo).toBe(novoTitulo)
  })

  it("excluir em ordem de FK e confirmar 404", async () => {
    const tarefaExcluida = ids.tarefa
    for (const [resource, chave] of [
      ["tarefas", "tarefa"],
      ["regras_recorrencia", "regra"],
      ["tags", "tag"],
      ["areas", "area"],
      ["colaboradores", "colaborador"],
      ["organizacoes", "organizacao"],
    ] as Array<[string, keyof typeof ids]>) {
      const id = ids[chave]
      expect(id, `${resource} deveria ter sido criada`).toBeTruthy()
      const resposta = await api("delete", `${resource}/${id}`)
      expect([200, 204]).toContain(resposta.status)
      ids[chave] = undefined
    }

    const detalhe = await api("get", `tarefas/${tarefaExcluida}`)
    expect(detalhe.status).toBe(404)
  })

  it("resource fora da whitelist do projeto → 404", async () => {
    const resposta = await api("get", "tabelas_inexistentes")
    expect(resposta.status).toBe(404)
  })
})
