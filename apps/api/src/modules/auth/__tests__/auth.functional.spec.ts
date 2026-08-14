/**
 * Testes funcionais do módulo Auth — API real + MySQL real em container
 * (critérios de saída da Etapa 3). Requer o MySQL do docker-compose no ar.
 *
 * O usuário de teste (teste_funcional) é provisionado e removido pelo
 * próprio teste; o usuário alexandre NÃO é alterado (change-password é
 * exercitado apenas no usuário de teste).
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

const SENHA_ALEXANDRE = "Bo4MfU29r0GPi1" // seed inicial (PoC §9.3)
const USUARIO_TESTE = "teste_funcional"
const SENHA_TESTE = "TesteFuncional#2026"
const SENHA_NOVA = "NovaSenhaFuncional#2026"

describe("auth — funcional (API + MySQL)", () => {
  let app: INestApplication
  let db: CoreDb

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    db = app.get<CoreDb>(CORE_DB)

    // Provisiona o usuário de teste (limpa resíduo de execuções anteriores).
    await limparUsuarioTeste()
    const hash = await argon2.hash(SENHA_TESTE, { type: argon2.argon2id })
    await db.insert(usuarios).values({
      username: USUARIO_TESTE,
      email: "teste.funcional@exemplo.com",
      nome: "Usuária de Teste",
      passwordHash: hash,
      ativo: true,
    })
    const usuario = await usuarioTeste()
    const documentacao = (
      await db
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, "documentacao"))
    ).at(0)
    if (!usuario || !documentacao) {
      throw new Error("pré-requisitos do teste funcional ausentes")
    }
    await db.insert(projetosUsuarios).values({
      projetoId: documentacao.id,
      usuarioId: usuario.id,
      perfil: "operador",
    })
  }, 60_000)

  afterAll(async () => {
    await limparUsuarioTeste()
    await app.close()
  }, 30_000)

  async function usuarioTeste() {
    return (
      await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(eq(usuarios.username, USUARIO_TESTE))
    ).at(0)
  }

  async function limparUsuarioTeste(): Promise<void> {
    const usuario = await (
      await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(eq(usuarios.username, USUARIO_TESTE))
    ).at(0)
    if (!usuario) return
    await db
      .delete(projetosUsuarios)
      .where(eq(projetosUsuarios.usuarioId, usuario.id))
    await db.delete(usuarios).where(eq(usuarios.id, usuario.id))
  }

  async function login(identifier: string, password: string) {
    return request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ identifier, password, identifierType: "username" })
  }

  it("login do alexandre devolve refresh + 2 projetos", async () => {
    const resposta = await login("alexandre", SENHA_ALEXANDRE)
    expect(resposta.status).toBe(201)
    expect(resposta.body.refreshToken).toBeTruthy()
    expect(resposta.body.usuario.nome).toBe("Alexandre")
    expect(resposta.body.usuario).not.toHaveProperty("passwordHash")
    expect(resposta.body.projetos).toHaveLength(2)
  })

  it("fluxo completo: select-project → access token → /auth/me", async () => {
    const respostaLogin = await login("alexandre", SENHA_ALEXANDRE)
    const refreshToken: string = respostaLogin.body.refreshToken
    const biblioteca = (respostaLogin.body.projetos as Array<{
      slug: string
      id: number
    }>).find((p) => p.slug === "biblioteca-global")
    expect(biblioteca).toBeDefined()

    const respostaSelect = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${refreshToken}`)
      .send({ projetoId: biblioteca?.id })
    expect(respostaSelect.status).toBe(201)
    const accessToken: string = respostaSelect.body.accessToken
    expect(accessToken).toBeTruthy()
    expect(respostaSelect.body.projeto.perfil).toBe("admin")

    const respostaMe = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
    expect(respostaMe.status).toBe(200)
    expect(respostaMe.body.usuario.nome).toBe("Alexandre")
    expect(respostaMe.body.projeto.slug).toBe("biblioteca-global")
    expect(respostaMe.body.perfil).toBe("admin")
  })

  it("token inválido em rota autenticada → 401", async () => {
    const resposta = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Authorization", "Bearer token-invalido")
    expect(resposta.status).toBe(401)
  })

  it("usuário não pode selecionar projeto sem vínculo → 403", async () => {
    const respostaLogin = await login(USUARIO_TESTE, SENHA_TESTE)
    expect(respostaLogin.status).toBe(201)
    expect(respostaLogin.body.projetos).toHaveLength(1)

    const bibliotecaGlobal = (
      await db
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, "biblioteca-global"))
    ).at(0)
    const respostaSelect = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${respostaLogin.body.refreshToken}`)
      .send({ projetoId: bibliotecaGlobal?.id })
    expect(respostaSelect.status).toBe(403)
  })

  it("change-password: nova senha funciona, antiga falha", async () => {
    const respostaLogin = await login(USUARIO_TESTE, SENHA_TESTE)
    const refreshToken: string = respostaLogin.body.refreshToken
    const documentacao = (respostaLogin.body.projetos as Array<{ id: number }>).at(0)

    const respostaSelect = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${refreshToken}`)
      .send({ projetoId: documentacao?.id })
    const accessToken: string = respostaSelect.body.accessToken

    const respostaTroca = await request(app.getHttpServer())
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ senhaAtual: SENHA_TESTE, novaSenha: SENHA_NOVA })
    expect(respostaTroca.status).toBe(201)

    const loginAntiga = await login(USUARIO_TESTE, SENHA_TESTE)
    expect(loginAntiga.status).toBe(401)
    const loginNova = await login(USUARIO_TESTE, SENHA_NOVA)
    expect(loginNova.status).toBe(201)

    // Restaura a senha original para manter o teste re-executável.
    const respostaSelect2 = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${loginNova.body.refreshToken}`)
      .send({ projetoId: documentacao?.id })
    await request(app.getHttpServer())
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${respostaSelect2.body.accessToken}`)
      .send({ senhaAtual: SENHA_NOVA, novaSenha: SENHA_TESTE })
  })

  it("logout revoga o refresh token (refresh posterior → 401)", async () => {
    const respostaLogin = await login(USUARIO_TESTE, SENHA_TESTE)
    const refreshToken: string = respostaLogin.body.refreshToken

    const respostaLogout = await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${refreshToken}`)
    expect(respostaLogout.status).toBe(201)

    const respostaRefresh = await request(app.getHttpServer())
      .post("/api/auth/refresh")
      .set("Authorization", `Bearer ${refreshToken}`)
    expect(respostaRefresh.status).toBe(401)
  })

  it("validação de entrada: login sem identifierType → 400", async () => {
    const resposta = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ identifier: "alexandre", password: "qualquer" })
    expect(resposta.status).toBe(400)
    expect(resposta.body.code).toBe("VALIDATION_ERROR")
  })
})
