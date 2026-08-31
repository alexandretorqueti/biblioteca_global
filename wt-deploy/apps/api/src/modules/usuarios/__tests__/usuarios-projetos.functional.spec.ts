// @vitest-environment node
/**
 * Testes funcionais — módulos Usuários e Projetos (critérios de saída da
 * Etapa 4). API real + MySQL real. Usuários/projeto de teste são
 * provisionados e removidos pelo próprio teste.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import argon2 from "argon2"
import { eq } from "drizzle-orm"
import mysql from "mysql2/promise"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { EnvService } from "../../../config/env.service"
import { CORE_DB, CORE_POOL, type CoreDb } from "../../../database/database.module"
import type { Pool } from "mysql2/promise"

const SENHA_ALEXANDRE = "Bo4MfU29r0GPi1" // seed inicial (PoC §9.3)
const SENHA_TESTE = "Etapa4Funcional#2026"
const USUARIO_DOC = "teste_etapa4_doc"
const USUARIO_SO_BG = "teste_etapa4_so_bg"
const SLUG_TESTE = "projeto-teste-etapa4"

describe("usuarios + projetos — funcional (API + MySQL)", () => {
  let app: INestApplication
  let db: CoreDb
  let pool: Pool
  let documentacaoId: number
  let bibliotecaGlobalId: number
  let usuarioDocId: number
  let projetoTesteId: number | undefined

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    db = app.get<CoreDb>(CORE_DB)
    pool = app.get<Pool>(CORE_POOL)

    const linhasProjetos = await db
      .select({ id: projetos.id, slug: projetos.slug })
      .from(projetos)
    const documentacao = linhasProjetos.find((p) => p.slug === "documentacao")
    const bibliotecaGlobal = linhasProjetos.find(
      (p) => p.slug === "biblioteca-global",
    )
    if (!documentacao || !bibliotecaGlobal) {
      throw new Error("projetos do seed ausentes")
    }
    documentacaoId = documentacao.id
    bibliotecaGlobalId = bibliotecaGlobal.id

    await limparDadosDeTeste()
    const hash = await argon2.hash(SENHA_TESTE, { type: argon2.argon2id })
    for (const username of [USUARIO_DOC, USUARIO_SO_BG]) {
      await db.insert(usuarios).values({
        username,
        email: `${username}@exemplo.com`,
        nome: `Teste Etapa 4 (${username})`,
        passwordHash: hash,
        ativo: true,
      })
    }
    const usuarioDoc = (
      await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(eq(usuarios.username, USUARIO_DOC))
    ).at(0)
    const usuarioSoBg = (
      await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(eq(usuarios.username, USUARIO_SO_BG))
    ).at(0)
    if (!usuarioDoc || !usuarioSoBg) {
      throw new Error("falha ao provisionar usuários de teste")
    }
    usuarioDocId = usuarioDoc.id
    await db.insert(projetosUsuarios).values([
      { projetoId: documentacaoId, usuarioId: usuarioDoc.id, perfil: "operador" },
      { projetoId: bibliotecaGlobalId, usuarioId: usuarioSoBg.id, perfil: "operador" },
    ])
  }, 90_000)

  afterAll(async () => {
    await limparDadosDeTeste()
    await app.close()
  }, 60_000)

  async function limparDadosDeTeste(): Promise<void> {
    // Usuários de teste (vínculos antes, FK sem cascade na pivot).
    for (const username of [USUARIO_DOC, USUARIO_SO_BG]) {
      const usuario = (
        await db
          .select({ id: usuarios.id })
          .from(usuarios)
          .where(eq(usuarios.username, username))
      ).at(0)
      if (usuario) {
        await db
          .delete(projetosUsuarios)
          .where(eq(projetosUsuarios.usuarioId, usuario.id))
        await db.delete(usuarios).where(eq(usuarios.id, usuario.id))
      }
    }
    // Projeto de teste + database provisionado.
    const projetoTeste = (
      await db
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, SLUG_TESTE))
    ).at(0)
    if (projetoTeste) {
      const env = app.get(EnvService)
      const root = await mysql.createConnection({
        host: env.mysqlHost,
        port: env.mysqlPort,
        user: "root",
        password: env.mysqlRootPassword,
      })
      await root.query(`DROP DATABASE IF EXISTS \`projeto_${projetoTeste.id}\``)
      await root.end()
      await db.delete(projetos).where(eq(projetos.id, projetoTeste.id))
    }
  }

  async function loginAlexandre(): Promise<string> {
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

  async function selecionarProjeto(refreshToken: string, projetoId: number) {
    const resposta = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${refreshToken}`)
      .send({ projetoId })
    expect(resposta.status).toBe(201)
    return resposta.body.accessToken as string
  }

  it("logado no documentacao: lista só usuários vinculados ao projeto", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      documentacaoId,
    )
    const resposta = await request(app.getHttpServer())
      .get("/api/usuarios")
      .set("Authorization", `Bearer ${accessToken}`)
    expect(resposta.status).toBe(200)
    const nomes = (resposta.body.items as Array<{ username: string | null }>).map(
      (u) => u.username,
    )
    expect(nomes).toContain(USUARIO_DOC)
    expect(nomes).toContain("alexandre")
    // Usuário vinculado só ao biblioteca-global não pode aparecer.
    expect(nomes).not.toContain(USUARIO_SO_BG)
  })

  it("criar usuário com projetoId no body → 400 (campo jamais aceito)", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      documentacaoId,
    )
    const resposta = await request(app.getHttpServer())
      .post("/api/usuarios")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        nome: "Tentativa Injeção",
        senhaInicial: "senha-inicial-123",
        email: "injecao@exemplo.com",
        projetoId: bibliotecaGlobalId,
      })
    expect(resposta.status).toBe(400)
    expect(resposta.body.code).toBe("VALIDATION_ERROR")
  })

  it("criar usuário no documentacao → vínculo automático; DELETE desvincula sem apagar", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      documentacaoId,
    )
    const resposta = await request(app.getHttpServer())
      .post("/api/usuarios")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        nome: "Criado Via API",
        senhaInicial: "senha-inicial-123",
        username: "criado_via_api_etapa4",
      })
    expect(resposta.status).toBe(201)
    const criadoId: number = resposta.body.id
    expect(resposta.body.perfil).toBe("operador")

    // Aparece na listagem do projeto.
    const listagem = await request(app.getHttpServer())
      .get("/api/usuarios")
      .set("Authorization", `Bearer ${accessToken}`)
    const ids = (listagem.body.items as Array<{ id: number }>).map((u) => u.id)
    expect(ids).toContain(criadoId)

    // DELETE desvincula; o usuário global continua existindo.
    const exclusao = await request(app.getHttpServer())
      .delete(`/api/usuarios/${criadoId}`)
      .set("Authorization", `Bearer ${accessToken}`)
    expect(exclusao.status).toBe(200)

    const linhaUsuario = (
      await db.select().from(usuarios).where(eq(usuarios.id, criadoId))
    ).at(0)
    expect(linhaUsuario).toBeDefined()
    const vinculo = (
      await db
        .select()
        .from(projetosUsuarios)
        .where(eq(projetosUsuarios.usuarioId, criadoId))
    ).at(0)
    expect(vinculo).toBeUndefined()

    // Limpa o usuário remanescente.
    await db.delete(usuarios).where(eq(usuarios.id, criadoId))
  })

  it("logado no biblioteca-global: vê usuários de qualquer projeto via ?projetoId=", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      bibliotecaGlobalId,
    )

    const doDocumentacao = await request(app.getHttpServer())
      .get(`/api/usuarios?projetoId=${documentacaoId}`)
      .set("Authorization", `Bearer ${accessToken}`)
    expect(doDocumentacao.status).toBe(200)
    const nomes = (
      doDocumentacao.body.items as Array<{ username: string | null }>
    ).map((u) => u.username)
    expect(nomes).toContain(USUARIO_DOC)

    const semFiltro = await request(app.getHttpServer())
      .get("/api/usuarios")
      .set("Authorization", `Bearer ${accessToken}`)
    const nomesBg = (
      semFiltro.body.items as Array<{ username: string | null }>
    ).map((u) => u.username)
    expect(nomesBg).toContain(USUARIO_SO_BG)
    expect(nomesBg).not.toContain(USUARIO_DOC)
  })

  it("admin global gerencia vínculos via /vincular (add/remove)", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      bibliotecaGlobalId,
    )

    const adicionar = await request(app.getHttpServer())
      .put(`/api/usuarios/${usuarioDocId}/vincular`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ adicionar: [{ projetoId: bibliotecaGlobalId, perfil: "visualizador" }] })
    expect(adicionar.status).toBe(200)

    const vinculo = (
      await db
        .select({ perfil: projetosUsuarios.perfil })
        .from(projetosUsuarios)
        .where(
          eq(projetosUsuarios.usuarioId, usuarioDocId),
        )
    ).filter((v) => v.perfil === "visualizador")
    expect(vinculo.length).toBeGreaterThan(0)

    const remover = await request(app.getHttpServer())
      .put(`/api/usuarios/${usuarioDocId}/vincular`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ remover: [bibliotecaGlobalId] })
    expect(remover.status).toBe(200)
  })

  it("token de projeto comum tentando operar projetos → 403", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      documentacaoId,
    )
    const listar = await request(app.getHttpServer())
      .get("/api/projetos")
      .set("Authorization", `Bearer ${accessToken}`)
    expect(listar.status).toBe(403)

    const criar = await request(app.getHttpServer())
      .post("/api/projetos")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ nome: "Golpe", slug: "golpe" })
    expect(criar.status).toBe(403)

    const vincular = await request(app.getHttpServer())
      .put(`/api/usuarios/${usuarioDocId}/vincular`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ adicionar: [{ projetoId: bibliotecaGlobalId, perfil: "admin" }] })
    expect(vincular.status).toBe(403)
  })

  it("admin global cria projeto: database provisionado; config validada; soft delete", async () => {
    const accessToken = await selecionarProjeto(
      await loginAlexandre(),
      bibliotecaGlobalId,
    )

    // Criação → ciclo de vida completo (registro + CREATE DATABASE).
    const criar = await request(app.getHttpServer())
      .post("/api/projetos")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ nome: "Projeto Teste Etapa 4", slug: SLUG_TESTE })
    expect(criar.status).toBe(201)
    projetoTesteId = criar.body.id as number
    expect(criar.body.database).toBe(`projeto_${projetoTesteId}`)

    // O database existe de verdade.
    const [databases] = await pool.query("SHOW DATABASES")
    const nomes = (databases as Array<{ Database: string }>).map(
      (d) => d.Database,
    )
    expect(nomes).toContain(`projeto_${projetoTesteId}`)

    // Config inválida (campo inexistente) → 400.
    const configInvalida = await request(app.getHttpServer())
      .put(`/api/projetos/${projetoTesteId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        config: { app: { name: "X" }, groups: [], campoInexistente: true },
      })
    expect(configInvalida.status).toBe(400)

    // Config válida → salva.
    const configValida = await request(app.getHttpServer())
      .put(`/api/projetos/${projetoTesteId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        nome: "Projeto Teste Etapa 4 (editado)",
        config: { app: { name: "Editado" }, groups: [] },
      })
    expect(configValida.status).toBe(200)
    expect(configValida.body.config.app.name).toBe("Editado")

    // DELETE = soft delete (ativo=false, database preservado).
    const excluir = await request(app.getHttpServer())
      .delete(`/api/projetos/${projetoTesteId}`)
      .set("Authorization", `Bearer ${accessToken}`)
    expect(excluir.status).toBe(200)

    const detalhe = await request(app.getHttpServer())
      .get(`/api/projetos/${projetoTesteId}`)
      .set("Authorization", `Bearer ${accessToken}`)
    expect(detalhe.body.ativo).toBe(false)
  })
})
