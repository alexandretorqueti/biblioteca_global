// @vitest-environment node
/**
 * Teste de integração do isolamento entre organizações (tenancy
 * intra-projeto — macro #2, subtarefa 2): API real + MySQL real
 * (core + projeto do gestao-de-tarefas-global).
 *
 * Critério de aceite: "usuário A não lê nem escreve dados de B (404/403) e a
 * listagem de A não expõe registros de B" — cobrindo CADA recurso de negócio
 * do projeto (organizacoes, colaboradores, areas, tags, regras_recorrencia,
 * tarefas, tarefa_tags, mensagens_tarefa, anexos, historico_tarefas,
 * notificacoes), além de:
 * - organizacao_id enviado no body por não-master é ignorado (sessão vence);
 * - FK no create/update apontando para outra organização → 400 claro;
 * - pivot (tags da tarefa) com id de outra organização → 400;
 * - criação/remoção de organizações via CRUD → 403 (endpoints de administração).
 *
 * Duas organizações (A e B) com um colaborador/usuário cada são semeadas
 * direto no banco; todo o tráfego HTTP acontece como usuário A (e uma
 * checagem de simetria como B). Limpeza completa ao final (FK-order), sem
 * tocar em dados de outros projetos/organizações.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import argon2 from "argon2"
import { eq, inArray } from "drizzle-orm"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../../database/schema"
import {
  anexos,
  areas,
  colaboradores as colaboradoresProjeto,
  historicoTarefas,
  mensagensTarefa,
  notificacoes,
  organizacoes as organizacoesProjeto,
  regrasRecorrencia,
  tags,
  tarefaTags,
  tarefas,
} from "../../../../../../projects/gestao-de-tarefas-global/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import { PROJECT_DB_FACTORY, type ProjectDbFactory, type ProjetoDb } from "../project-db.factory"

const SLUG = "gestao-de-tarefas-global"
const SUFIXO = `tenancy-${Date.now()}`
const SENHA = "Tenancy#2026"
const USUARIO_A = `teste_tenancy_a_${Date.now()}`
const USUARIO_B = `teste_tenancy_b_${Date.now()}`
const hasMysql = Boolean(process.env.MYSQL_HOST)

/** Todos os resources de negócio do projeto (whitelist do CRUD). */
const RESOURCES = [
  "organizacoes",
  "colaboradores",
  "areas",
  "tags",
  "regras_recorrencia",
  "tarefas",
  "tarefa_tags",
  "mensagens_tarefa",
  "anexos",
  "historico_tarefas",
  "notificacoes",
] as const

describe.skipIf(!hasMysql)("Tenancy intra-projeto — isolamento A×B (funcional)", () => {
  let app: INestApplication
  let db: CoreDb
  let pdb: ProjetoDb
  let tokenA: string
  let tokenB: string
  let projetoId: number
  let usuarioAId: number
  let usuarioBId: number

  const org: { A: number; B: number } = { A: 0, B: 0 }
  const colab: { A: number; B: number } = { A: 0, B: 0 }
  const dados: Record<"A" | "B", Record<string, number>> = { A: {}, B: {} }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    db = app.get<CoreDb>(CORE_DB)
    const factory = app.get<ProjectDbFactory>(PROJECT_DB_FACTORY)

    const projeto = (
      await db.select({ id: projetos.id }).from(projetos).where(eq(projetos.slug, SLUG))
    ).at(0)
    if (!projeto) throw new Error(`pré-requisito ausente: projeto ${SLUG} no core`)
    projetoId = projeto.id
    pdb = await factory.obter({ id: projetoId })

    await limparUsuarios()
    usuarioAId = await criarUsuario(USUARIO_A)
    usuarioBId = await criarUsuario(USUARIO_B)

    // Semeia organizações A e B com um colaborador/usuário cada.
    for (const lado of ["A", "B"] as const) {
      const usuarioId = lado === "A" ? usuarioAId : usuarioBId
      const [orgRow] = await pdb
        .insert(organizacoesProjeto)
        .values({ nome: `Org ${lado} ${SUFIXO}` })
        .$returningId()
      org[lado] = Number(orgRow!.id)
      const [colabRow] = await pdb
        .insert(colaboradoresProjeto)
        .values({
          organizacaoId: org[lado],
          nome: `Colaborador ${lado} ${SUFIXO}`,
          email: `colab-${lado.toLowerCase()}.${SUFIXO}@exemplo.com`,
          ativo: true,
          usuarioId,
        })
        .$returningId()
      colab[lado] = Number(colabRow!.id)
      await semearDadosLado(lado)
    }

    tokenA = await login(USUARIO_A)
    tokenB = await login(USUARIO_B)
  }, 180_000)

  afterAll(async () => {
    if (app) {
      await limparDadosProjeto()
      await limparUsuarios()
      await app.close()
    }
  }, 120_000)

  async function criarUsuario(username: string): Promise<number> {
    const hash = await argon2.hash(SENHA, { type: argon2.argon2id })
    await db.insert(usuarios).values({
      username,
      email: `${username}@exemplo.com`,
      nome: `Usuário ${username}`,
      passwordHash: hash,
      ativo: true,
    })
    const usuario = (
      await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, username))
    ).at(0)
    if (!usuario) throw new Error(`usuário ${username} não criado`)
    await db.insert(projetosUsuarios).values({
      projetoId,
      usuarioId: usuario.id,
      perfil: "admin",
    })
    return Number(usuario.id)
  }

  async function login(username: string): Promise<string> {
    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ identifier: username, password: SENHA, identifierType: "username", consentimentoAceito: true })
    expect(login.status).toBe(201)
    const select = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${login.body.refreshToken}`)
      .send({ projetoId })
    expect(select.status).toBe(201)
    expect(select.body.accessToken).toBeTruthy()
    return select.body.accessToken as string
  }

  /** Semeia um registro por resource de negócio para o lado (A ou B). */
  async function semearDadosLado(lado: "A" | "B"): Promise<void> {
    const orgId = org[lado]
    const colabId = colab[lado]
    const d = dados[lado]

    const [area] = await pdb
      .insert(areas)
      .values({ organizacaoId: orgId, nome: `Área ${lado} ${SUFIXO}` })
      .$returningId()
    d.area = Number(area!.id)

    const [tag] = await pdb
      .insert(tags)
      .values({ organizacaoId: orgId, nome: `tag-${lado}-${SUFIXO}` })
      .$returningId()
    d.tag = Number(tag!.id)

    const [regra] = await pdb
      .insert(regrasRecorrencia)
      .values({
        organizacaoId: orgId,
        titulo: `Regra ${lado} ${SUFIXO}`,
        areaId: d.area,
        responsavelId: colabId,
        frequencia: "diaria",
        dataInicio: new Date("2026-11-01T00:00:00Z"),
      })
      .$returningId()
    d.regra = Number(regra!.id)

    const [tarefa] = await pdb
      .insert(tarefas)
      .values({
        organizacaoId: orgId,
        titulo: `Tarefa ${lado} ${SUFIXO}`,
        areaId: d.area,
        responsavelId: colabId,
        criadoPorId: colabId,
      })
      .$returningId()
    d.tarefa = Number(tarefa!.id)

    const [pivot] = await pdb
      .insert(tarefaTags)
      .values({ tarefaId: d.tarefa, tagId: d.tag })
      .$returningId()
    d.pivot = Number(pivot!.id)

    const [mensagem] = await pdb
      .insert(mensagensTarefa)
      .values({ tarefaId: d.tarefa, autorId: colabId, texto: `msg ${lado} ${SUFIXO}` })
      .$returningId()
    d.mensagem = Number(mensagem!.id)

    const [anexo] = await pdb
      .insert(anexos)
      .values({
        tarefaId: d.tarefa,
        organizacaoId: orgId,
        nomeArquivo: `${lado}-${SUFIXO}.txt`,
        chaveArmazenamento: `chaves/${lado}-${SUFIXO}.txt`,
        enviadoPorId: colabId,
      })
      .$returningId()
    d.anexo = Number(anexo!.id)

    const [historico] = await pdb
      .insert(historicoTarefas)
      .values({ tarefaId: d.tarefa, tipoEvento: "criacao", mensagem: `criação ${lado}` })
      .$returningId()
    d.historico = Number(historico!.id)

    const [notificacao] = await pdb
      .insert(notificacoes)
      .values({
        organizacaoId: orgId,
        usuarioId: lado === "A" ? usuarioAId : usuarioBId,
        titulo: `Notificação ${lado} ${SUFIXO}`,
        tipo: "sistema",
        tarefaId: d.tarefa,
      })
      .$returningId()
    d.notificacao = Number(notificacao!.id)

    d.colab = colabId
    d.org = orgId
  }

  function api(
    token: string,
    method: "get" | "post" | "put" | "delete",
    path: string,
    body?: Record<string, unknown>,
  ) {
    const req = request(app.getHttpServer())[method](`/api/${SLUG}/${path}`)
    const autenticado = req.set("Authorization", `Bearer ${token}`)
    return body !== undefined ? autenticado.send(body) : autenticado
  }

  /** id do registro semeado de B por resource. */
  function idDeB(resource: string): number {
    const mapa: Record<string, number | undefined> = {
      organizacoes: org.B,
      colaboradores: colab.B,
      areas: dados.B.area,
      tags: dados.B.tag,
      regras_recorrencia: dados.B.regra,
      tarefas: dados.B.tarefa,
      tarefa_tags: dados.B.pivot,
      mensagens_tarefa: dados.B.mensagem,
      anexos: dados.B.anexo,
      historico_tarefas: dados.B.historico,
      notificacoes: dados.B.notificacao,
    }
    const id = mapa[resource]
    expect(id, `registro de B ausente para ${resource}`).toBeTruthy()
    return Number(id)
  }

  function idDeA(resource: string): number {
    const mapa: Record<string, number | undefined> = {
      organizacoes: org.A,
      colaboradores: colab.A,
      areas: dados.A.area,
      tags: dados.A.tag,
      regras_recorrencia: dados.A.regra,
      tarefas: dados.A.tarefa,
      tarefa_tags: dados.A.pivot,
      mensagens_tarefa: dados.A.mensagem,
      anexos: dados.A.anexo,
      historico_tarefas: dados.A.historico,
      notificacoes: dados.A.notificacao,
    }
    return Number(mapa[resource])
  }

  async function limparUsuarios(): Promise<void> {
    for (const username of [USUARIO_A, USUARIO_B]) {
      const id = (
        await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, username))
      ).at(0)?.id
      if (!id) continue
      await db.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, id))
      await db.delete(usuarios).where(eq(usuarios.id, id))
    }
  }

  async function limparDadosProjeto(): Promise<void> {
    if (!pdb) return
    const orgIds = Object.values(org).filter(Boolean)
    if (orgIds.length === 0) return
    const tarefaIds = (
      await pdb.select({ id: tarefas.id }).from(tarefas).where(inArray(tarefas.organizacaoId, orgIds))
    ).map((t) => Number(t.id))
    if (tarefaIds.length > 0) {
      await pdb.delete(tarefaTags).where(inArray(tarefaTags.tarefaId, tarefaIds))
      await pdb.delete(mensagensTarefa).where(inArray(mensagensTarefa.tarefaId, tarefaIds))
      await pdb.delete(historicoTarefas).where(inArray(historicoTarefas.tarefaId, tarefaIds))
      await pdb.delete(anexos).where(inArray(anexos.tarefaId, tarefaIds))
    }
    await pdb.delete(notificacoes).where(inArray(notificacoes.organizacaoId, orgIds))
    await pdb.delete(tarefas).where(inArray(tarefas.organizacaoId, orgIds))
    await pdb.delete(regrasRecorrencia).where(inArray(regrasRecorrencia.organizacaoId, orgIds))
    await pdb.delete(tags).where(inArray(tags.organizacaoId, orgIds))
    await pdb.delete(areas).where(inArray(areas.organizacaoId, orgIds))
    await pdb.delete(colaboradoresProjeto).where(inArray(colaboradoresProjeto.organizacaoId, orgIds))
    await pdb.delete(organizacoesProjeto).where(inArray(organizacoesProjeto.id, orgIds))
  }

  // ==========================================================================

  it("listagem de A não expõe registros de B em nenhum resource", async () => {
    for (const resource of RESOURCES) {
      const resposta = await api(tokenA, "get", `${resource}?pageSize=100`)
      expect(resposta.status, `GET ${resource}`).toBe(200)
      const ids = (resposta.body.items as Array<{ id: number }>).map((i) => Number(i.id))
      expect(ids, `listagem de ${resource} deveria conter o registro de A`).toContain(idDeA(resource))
      expect(ids, `listagem de ${resource} NÃO deve conter o registro de B`).not.toContain(idDeB(resource))
    }
  })

  it("leitura de id de B → 404 em todos os resources (usuário A)", async () => {
    for (const resource of RESOURCES) {
      const resposta = await api(tokenA, "get", `${resource}/${idDeB(resource)}`)
      expect(resposta.status, `GET ${resource}/<id de B>`).toBe(404)
    }
  })

  it("escrita (PUT) em id de B → 404 em todos os resources (usuário A)", async () => {
    const corpos: Record<string, Record<string, unknown>> = {
      organizacoes: { nome: `invasão ${SUFIXO}` },
      colaboradores: { nome: `invasão ${SUFIXO}` },
      areas: { nome: `invasão ${SUFIXO}` },
      tags: { nome: `invasão-${SUFIXO}` },
      regras_recorrencia: { titulo: `invasão ${SUFIXO}` },
      tarefas: { titulo: `invasão ${SUFIXO}` },
      tarefa_tags: { tag_id: dados.A.tag },
      mensagens_tarefa: { texto: `invasão ${SUFIXO}` },
      anexos: { nome_arquivo: `invasao-${SUFIXO}.txt` },
      historico_tarefas: { mensagem: `invasão ${SUFIXO}` },
      notificacoes: { titulo: `invasão ${SUFIXO}` },
    }
    for (const resource of RESOURCES) {
      const resposta = await api(tokenA, "put", `${resource}/${idDeB(resource)}`, corpos[resource])
      expect(resposta.status, `PUT ${resource}/<id de B>`).toBe(404)
    }
  })

  it("exclusão (DELETE) de id de B → 404 em todos os resources (usuário A)", async () => {
    for (const resource of RESOURCES) {
      if (resource === "organizacoes") continue // remoção de organização é 403 (testado abaixo)
      const resposta = await api(tokenA, "delete", `${resource}/${idDeB(resource)}`)
      expect(resposta.status, `DELETE ${resource}/<id de B>`).toBe(404)
    }
  })

  it("simetria: usuário B também não lê dados de A", async () => {
    for (const resource of RESOURCES) {
      const resposta = await api(tokenB, "get", `${resource}/${idDeA(resource)}`)
      expect(resposta.status, `B → GET ${resource}/<id de A>`).toBe(404)
    }
    const lista = await api(tokenB, "get", `tarefas?pageSize=100`)
    expect(lista.status).toBe(200)
    const ids = (lista.body.items as Array<{ id: number }>).map((i) => Number(i.id))
    expect(ids).not.toContain(dados.A.tarefa)
  })

  it("organizacao_id no body é ignorado: criação sai na organização da sessão", async () => {
    const resposta = await api(tokenA, "post", "tags", {
      nome: `tag-forçada-${SUFIXO}`,
      organizacao_id: org.B,
    })
    expect([200, 201]).toContain(resposta.status)
    expect(Number(resposta.body.organizacaoId)).toBe(org.A)
    dados.A.tagForcada = Number(resposta.body.id)

    const detalhe = await api(tokenA, "get", `tags/${dados.A.tagForcada}`)
    expect(detalhe.status).toBe(200)
    expect(Number(detalhe.body.organizacaoId)).toBe(org.A)
  })

  it("FK de outra organização no create → 400 com erro claro", async () => {
    // area_id de B
    const t1 = await api(tokenA, "post", "tarefas", {
      titulo: `Tarefa invasora ${SUFIXO}`,
      area_id: dados.B.area,
      responsavel_id: colab.A,
      criado_por_id: colab.A,
    })
    expect(t1.status).toBe(400)
    expect(JSON.stringify(t1.body)).toContain("area_id")

    // responsavel_id de B
    const t2 = await api(tokenA, "post", "tarefas", {
      titulo: `Tarefa invasora ${SUFIXO}`,
      area_id: dados.A.area,
      responsavel_id: colab.B,
      criado_por_id: colab.A,
    })
    expect(t2.status).toBe(400)
    expect(JSON.stringify(t2.body)).toContain("responsavel_id")

    // tarefa_id de B (child)
    const m1 = await api(tokenA, "post", "mensagens_tarefa", {
      tarefa_id: dados.B.tarefa,
      autor_id: colab.A,
      texto: "invadindo o chat de B",
    })
    expect(m1.status).toBe(400)
    expect(JSON.stringify(m1.body)).toContain("tarefa_id")

    // tag_id de B no pivot tarefa_tags
    const p1 = await api(tokenA, "post", "tarefa_tags", {
      tarefa_id: dados.A.tarefa,
      tag_id: dados.B.tag,
    })
    expect(p1.status).toBe(400)
    expect(JSON.stringify(p1.body)).toContain("tag_id")

    // anexo em tarefa de B
    const a1 = await api(tokenA, "post", "anexos", {
      tarefa_id: dados.B.tarefa,
      nome_arquivo: `x-${SUFIXO}.txt`,
      chave_armazenamento: `chaves/x-${SUFIXO}.txt`,
      enviado_por_id: colab.A,
    })
    expect(a1.status).toBe(400)

    // historico em tarefa de B
    const h1 = await api(tokenA, "post", "historico_tarefas", {
      tarefa_id: dados.B.tarefa,
      tipo_evento: "criacao",
    })
    expect(h1.status).toBe(400)

    // regra de recorrência com área de B
    const r1 = await api(tokenA, "post", "regras_recorrencia", {
      titulo: `Regra invasora ${SUFIXO}`,
      area_id: dados.B.area,
      responsavel_id: colab.A,
      frequencia: "diaria",
      data_inicio: "2026-11-01",
    })
    expect(r1.status).toBe(400)
  })

  it("FK de outra organização no update → 400 (área de B em tarefa de A)", async () => {
    const resposta = await api(tokenA, "put", `tarefas/${dados.A.tarefa}`, {
      area_id: dados.B.area,
    })
    expect(resposta.status).toBe(400)
    expect(JSON.stringify(resposta.body)).toContain("area_id")
  })

  it("pivot tags no update: tag de B → 400; tag de A → 200", async () => {
    const invasao = await api(tokenA, "put", `tarefas/${dados.A.tarefa}`, {
      tags: [dados.B.tag],
    })
    expect(invasao.status).toBe(400)

    const legitimo = await api(tokenA, "put", `tarefas/${dados.A.tarefa}`, {
      tags: [dados.A.tag],
    })
    expect(legitimo.status).toBe(200)
    expect(legitimo.body.tags).toEqual([dados.A.tag])
  })

  it("organizações: A só vê a própria; create/delete via CRUD → 403", async () => {
    const lista = await api(tokenA, "get", "organizacoes?pageSize=100")
    expect(lista.status).toBe(200)
    const ids = (lista.body.items as Array<{ id: number }>).map((i) => Number(i.id))
    expect(ids).toContain(org.A)
    expect(ids).not.toContain(org.B)

    const criar = await api(tokenA, "post", "organizacoes", { nome: `Org invasora ${SUFIXO}` })
    expect(criar.status).toBe(403)

    const remover = await api(tokenA, "delete", `organizacoes/${org.A}`)
    expect(remover.status).toBe(403)
  })

  it("filtro explícito por organização alheia não vaza dados", async () => {
    const resposta = await api(tokenA, "get", `tarefas?organizacaoId=${org.B}&pageSize=100`)
    expect(resposta.status).toBe(200)
    expect(resposta.body.items).toEqual([])
    expect(Number(resposta.body.total)).toBe(0)
  })

  it("update em organizacoes: só a própria (B → 404; A → 200)", async () => {
    const invasao = await api(tokenA, "put", `organizacoes/${org.B}`, { nome: `Org hackeada ${SUFIXO}` })
    expect(invasao.status).toBe(404)

    const propria = await api(tokenA, "put", `organizacoes/${org.A}`, {
      descricao: "atualizada pelo próprio admin",
    })
    expect(propria.status).toBe(200)
    expect(Number(propria.body.id)).toBe(org.A)
  })
})
