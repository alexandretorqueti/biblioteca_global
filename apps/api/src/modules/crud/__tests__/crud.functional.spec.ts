// @vitest-environment node
/**
 * Testes funcionais — CRUD genérico por resource (critérios de saída da
 * Etapa 5). Provisiona o database do projeto documentacao com o
 * provisionador da própria API e prova o isolamento entre projetos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import mysql from "mysql2/promise"
import { projetos } from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { EnvService } from "../../../config/env.service"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import {
  PROJETO_PROVISIONER,
  type ProjetoProvisioner,
} from "../../projetos/provisioner.service"

const SENHA_ALEXANDRE = "Bo4MfU29r0GPi1" // seed inicial (PoC §9.3)

describe("crud genérico — funcional (API + MySQL)", () => {
  let app: INestApplication
  let db: CoreDb
  let documentacaoId: number
  let bibliotecaGlobalId: number
  let databaseDocumentacao: string
  let tokenDocumentacao: string
  let tokenBibliotecaGlobal: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    db = app.get<CoreDb>(CORE_DB)

    const linhas = await db.select({ id: projetos.id, slug: projetos.slug }).from(projetos)
    const documentacao = linhas.find((p) => p.slug === "documentacao")
    const bibliotecaGlobal = linhas.find((p) => p.slug === "biblioteca-global")
    if (!documentacao || !bibliotecaGlobal) {
      throw new Error("projetos do seed ausentes")
    }
    documentacaoId = documentacao.id
    bibliotecaGlobalId = bibliotecaGlobal.id
    databaseDocumentacao = `projeto_${documentacaoId}`

    // Provisiona o database do projeto documentacao com o mecanismo da API
    // (CREATE DATABASE + migrations da pasta — idempotente).
    const provisioner = app.get<ProjetoProvisioner>(PROJETO_PROVISIONER)
    await provisioner.prepararDatabase(databaseDocumentacao)
    await provisioner.aplicarMigrations("documentacao", databaseDocumentacao)

    tokenDocumentacao = await selecionarProjeto(
      await login(),
      documentacaoId,
    )
    tokenBibliotecaGlobal = await selecionarProjeto(
      await login(),
      bibliotecaGlobalId,
    )
  }, 120_000)

  afterAll(async () => {
    // Limpa as linhas criadas nos testes (database do projeto fica — é o
    // ambiente real do projeto documentacao).
    const env = app.get(EnvService)
    const root = await mysql.createConnection({
      host: env.mysqlHost,
      port: env.mysqlPort,
      user: "root",
      password: env.mysqlRootPassword,
      database: databaseDocumentacao,
    })
    await root.query("DELETE FROM componentes")
    await root.end()
    await app.close()
  }, 60_000)

  async function login(): Promise<string> {
    const resposta = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        identifier: "alexandre",
        password: SENHA_ALEXANDRE,
        identifierType: "username",
      })
    expect(resposta.status).toBe(201)
    return resposta.body.refreshToken as string
  }

  async function selecionarProjeto(
    refreshToken: string,
    projetoId: number,
  ): Promise<string> {
    const resposta = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${refreshToken}`)
      .send({ projetoId })
    expect(resposta.status).toBe(201)
    return resposta.body.accessToken as string
  }

  it("CRUD completo no database do projeto (create/read/update/delete)", async () => {
    // CREATE
    const criar = await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({
        nome: "Grid",
        categoria: "layout",
        descricao: "Grade responsiva",
        ordem: 1,
      })
    expect(criar.status).toBe(201)
    const id: number = criar.body.id
    expect(criar.body.nome).toBe("Grid")
    expect(criar.body.ativo).toBe(true) // default do schema

    // READ (lista paginada)
    const listar = await request(app.getHttpServer())
      .get("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(listar.status).toBe(200)
    expect(listar.body.total).toBeGreaterThanOrEqual(1)
    expect(listar.body.page).toBe(1)
    const ids = (listar.body.items as Array<{ id: number }>).map((i) => i.id)
    expect(ids).toContain(id)

    // READ (por id)
    const detalhe = await request(app.getHttpServer())
      .get(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(detalhe.status).toBe(200)
    expect(detalhe.body.nome).toBe("Grid")

    // UPDATE parcial
    const atualizar = await request(app.getHttpServer())
      .put(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "JsonGrid", ordem: 2 })
    expect(atualizar.status).toBe(200)
    expect(atualizar.body.nome).toBe("JsonGrid")
    expect(atualizar.body.ordem).toBe(2)

    // Filtro por coluna
    const filtrado = await request(app.getHttpServer())
      .get("/api/componentes?categoria=layout")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(filtrado.status).toBe(200)
    expect(filtrado.body.total).toBeGreaterThanOrEqual(1)

    // DELETE
    const remover = await request(app.getHttpServer())
      .delete(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(remover.status).toBe(200)

    const depois = await request(app.getHttpServer())
      .get(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(depois.status).toBe(404)
  })

  it("registro com campo inválido → 400; duplicado → 409", async () => {
    const invalido = await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "Sem Categoria" }) // categoria obrigatória ausente
    expect(invalido.status).toBe(400)
    expect(invalido.body.code).toBe("VALIDATION_ERROR")

    const campoExtra = await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "Extra", categoria: "x", naoExiste: true })
    expect(campoExtra.status).toBe(400)

    await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "Duplicado", categoria: "teste" })
    const duplicado = await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "Duplicado", categoria: "teste" })
    expect(duplicado.status).toBe(409)
  })

  it("resource inexistente → 404", async () => {
    const resposta = await request(app.getHttpServer())
      .get("/api/tabela_que_nao_existe")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(resposta.status).toBe(404)
  })

  it("ISOLAMENTO: token do biblioteca-global não acessa dados do documentacao", async () => {
    // Cria um registro com o token do documentacao.
    const criar = await request(app.getHttpServer())
      .post("/api/componentes")
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
      .send({ nome: "Isolado", categoria: "teste" })
    expect(criar.status).toBe(201)
    const id: number = criar.body.id

    // Lista com o token do biblioteca-global → resource fora da whitelist
    // daquele projeto → 404 (nem chega ao database).
    const listar = await request(app.getHttpServer())
      .get("/api/componentes")
      .set("Authorization", `Bearer ${tokenBibliotecaGlobal}`)
    expect(listar.status).toBe(404)

    // Tentativa direta pelo id conhecido → 404.
    const direto = await request(app.getHttpServer())
      .get(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenBibliotecaGlobal}`)
    expect(direto.status).toBe(404)

    // Escrita também bloqueada.
    const escrita = await request(app.getHttpServer())
      .put(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenBibliotecaGlobal}`)
      .send({ nome: "Invadido" })
    expect(escrita.status).toBe(404)

    // Limpa o registro criado.
    const remover = await request(app.getHttpServer())
      .delete(`/api/componentes/${id}`)
      .set("Authorization", `Bearer ${tokenDocumentacao}`)
    expect(remover.status).toBe(200)
  })
})
