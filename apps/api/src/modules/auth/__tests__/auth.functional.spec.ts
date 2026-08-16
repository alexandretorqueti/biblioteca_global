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
import { and, eq } from "drizzle-orm"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import { EnvService } from "../../../config/env.service"
import { EmailService } from "../email.service"

/** Fake do EmailService — captura o código sem enviar e-mail real. */
class FakeEmailService {
  ultimoCodigo = ""
  enviados = 0

  async sendVerificationEmail(input: {
    to: string
    code: string
  }): Promise<{ ok: true }> {
    this.ultimoCodigo = input.code
    this.enviados += 1
    return { ok: true }
  }
}

const SENHA_ALEXANDRE = "Bo4MfU29r0GPi1" // seed inicial (PoC §9.3)
const USUARIO_TESTE = "teste_funcional"
const SENHA_TESTE = "TesteFuncional#2026"
const SENHA_NOVA = "NovaSenhaFuncional#2026"

describe("auth — funcional (API + MySQL)", () => {
  let app: INestApplication
  let db: CoreDb
  let fakeEmail: FakeEmailService

  beforeAll(async () => {
    fakeEmail = new FakeEmailService()
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue(fakeEmail)
      .compile()
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

  // ── Auth por código (passwordless) — Etapa 10 ─────────────────────────

  it("código: request-code → verify-code → login direto (usuário com senha)", async () => {
    const pedido = await request(app.getHttpServer())
      .post("/api/auth/request-code")
      .send({ email: "teste.funcional@exemplo.com" })
    expect(pedido.status).toBe(201)
    expect(pedido.body).toEqual({ ok: true })
    expect(fakeEmail.ultimoCodigo).toMatch(/^\d{6}$/)

    const verificacao = await request(app.getHttpServer())
      .post("/api/auth/verify-code")
      .send({
        email: "teste.funcional@exemplo.com",
        code: fakeEmail.ultimoCodigo,
      })
    expect(verificacao.status).toBe(201)
    expect(verificacao.body.primeiraVez).toBe(false)
    expect(verificacao.body.refreshToken).toBeTruthy()
    expect(verificacao.body.usuario.email).toBe("teste.funcional@exemplo.com")
    expect(verificacao.body.projetos).toHaveLength(1)
  })

  it("código: request-code para e-mail inexistente → mesma resposta, nada enviado", async () => {
    const antes = fakeEmail.enviados
    const pedido = await request(app.getHttpServer())
      .post("/api/auth/request-code")
      .send({ email: "ninguem-cadastrado@exemplo.com" })
    expect(pedido.status).toBe(201)
    expect(pedido.body).toEqual({ ok: true })
    expect(fakeEmail.enviados).toBe(antes)
  })

  it("código: 1ª vez (sem senha) → verify-code → set-password → login com senha", async () => {
    const EMAIL = "cliente-primeira-vez@exemplo.com"
    const SENHA_NOVA = "SenhaPrimeiraVez#2026"
    await db.insert(usuarios).values({
      email: EMAIL,
      nome: "Cliente Primeira Vez",
      passwordHash: null,
      ativo: true,
    })
    try {
      const pedido = await request(app.getHttpServer())
        .post("/api/auth/request-code")
        .send({ email: EMAIL })
      expect(pedido.status).toBe(201)
      const codigo = fakeEmail.ultimoCodigo
      expect(codigo).toMatch(/^\d{6}$/)

      const verificacao = await request(app.getHttpServer())
        .post("/api/auth/verify-code")
        .send({ email: EMAIL, code: codigo })
      expect(verificacao.status).toBe(201)
      expect(verificacao.body.primeiraVez).toBe(true)
      const verificationToken: string = verificacao.body.verificationToken
      expect(verificationToken).toBeTruthy()

      const definicao = await request(app.getHttpServer())
        .post("/api/auth/set-password")
        .send({ verificationToken, novaSenha: SENHA_NOVA })
      expect(definicao.status).toBe(201)
      expect(definicao.body).toEqual({ ok: true })

      // Agora entra com a senha definida (fluxo normal).
      const loginSenha = await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ identifier: EMAIL, password: SENHA_NOVA, identifierType: "email" })
      expect(loginSenha.status).toBe(201)
      expect(loginSenha.body.refreshToken).toBeTruthy()

      // E o refresh funciona (rotação) + logout.
      const refresh = await request(app.getHttpServer())
        .post("/api/auth/refresh")
        .set("Authorization", `Bearer ${loginSenha.body.refreshToken}`)
      expect(refresh.status).toBe(201)
      const logout = await request(app.getHttpServer())
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${refresh.body.refreshToken}`)
      expect(logout.status).toBe(201)
    } finally {
      const criado = (
        await db
          .select({ id: usuarios.id })
          .from(usuarios)
          .where(eq(usuarios.email, EMAIL))
      ).at(0)
      if (criado) {
        await db
          .delete(projetosUsuarios)
          .where(eq(projetosUsuarios.usuarioId, criado.id))
        await db.delete(usuarios).where(eq(usuarios.id, criado.id))
      }
    }
  })

  it("código errado → 401; estouro de tentativas invalida", async () => {
    const EMAIL = "teste.funcional@exemplo.com"
    await request(app.getHttpServer())
      .post("/api/auth/request-code")
      .send({ email: EMAIL })
    const codigo = fakeEmail.ultimoCodigo

    for (let i = 0; i < 5; i++) {
      const errado = await request(app.getHttpServer())
        .post("/api/auth/verify-code")
        .send({ email: EMAIL, code: "000000" })
      expect(errado.status).toBe(401)
    }
    // Código correto já não vale (invalidado pelo estouro).
    const aposEstouro = await request(app.getHttpServer())
      .post("/api/auth/verify-code")
      .send({ email: EMAIL, code: codigo })
    expect(aposEstouro.status).toBe(401)
  })

  it("rate-limit: 4º pedido de código na janela é bloqueado silenciosamente", async () => {
    const EMAIL = "rate-limit-funcional@exemplo.com"
    await db.insert(usuarios).values({
      email: EMAIL,
      nome: "Rate Limit",
      passwordHash: null,
      ativo: true,
    })
    try {
      const antes = fakeEmail.enviados
      for (let i = 0; i < 4; i++) {
        const pedido = await request(app.getHttpServer())
          .post("/api/auth/request-code")
          .send({ email: EMAIL })
        expect(pedido.status).toBe(201)
        expect(pedido.body).toEqual({ ok: true })
      }
      // 3 permitidos por janela; o 4º responde igual mas não envia.
      expect(fakeEmail.enviados - antes).toBe(3)
    } finally {
      const criado = (
        await db
          .select({ id: usuarios.id })
          .from(usuarios)
          .where(eq(usuarios.email, EMAIL))
      ).at(0)
      if (criado) {
        await db
          .delete(projetosUsuarios)
          .where(eq(projetosUsuarios.usuarioId, criado.id))
        await db.delete(usuarios).where(eq(usuarios.id, criado.id))
      }
    }
  })

  describe("provision — funcional (token de serviço)", () => {
    const SLUG = "provision-teste-funcional"
    const EMAIL_NOVO = "provision-funcional@exemplo.com"
    let provisionToken: string
    let usuarioCriadoId: number | undefined
    let projetoCriadoId: number | undefined

    beforeAll(() => {
      provisionToken = app.get(EnvService).provisionToken
    })

    afterAll(async () => {
      if (usuarioCriadoId !== undefined) {
        await db
          .delete(projetosUsuarios)
          .where(eq(projetosUsuarios.usuarioId, usuarioCriadoId))
        await db.delete(usuarios).where(eq(usuarios.id, usuarioCriadoId))
      }
      if (projetoCriadoId !== undefined) {
        // Vínculos NÃO cascateiam na deleção do projeto — limpar os dois lados.
        await db
          .delete(projetosUsuarios)
          .where(eq(projetosUsuarios.projetoId, projetoCriadoId))
        await db.delete(projetos).where(eq(projetos.id, projetoCriadoId))
        // Remove o database físico (compensação do ciclo de vida).
        const env = app.get(EnvService)
        const mysql = await import("mysql2/promise")
        const conexao = await mysql.createConnection({
          host: env.mysqlHost,
          port: env.mysqlPort,
          user: "root",
          password: env.mysqlRootPassword,
        })
        try {
          await conexao.query(
            "DROP DATABASE IF EXISTS " +
              "`projeto_" +
              String(projetoCriadoId) +
              "`",
          )
        } finally {
          await conexao.end()
        }
      }
    })

    it("sem token de serviço → 401", async () => {
      const resposta = await request(app.getHttpServer())
        .post("/api/provision/project")
        .send({ email: EMAIL_NOVO, projetoNome: "Provision Teste" })
      expect(resposta.status).toBe(401)
    })

    it("token inválido → 401", async () => {
      const resposta = await request(app.getHttpServer())
        .post("/api/provision/project")
        .set("Authorization", "Bearer token-errado")
        .send({ email: EMAIL_NOVO, projetoNome: "Provision Teste" })
      expect(resposta.status).toBe(401)
    })

    it("e-mail novo: cria usuário sem senha + projeto + admin; repetição é idempotente", async () => {
      const chamada = async () =>
        request(app.getHttpServer())
          .post("/api/provision/project")
          .set("Authorization", `Bearer ${provisionToken}`)
          .send({ email: EMAIL_NOVO, projetoNome: "Provision Teste", projetoSlug: SLUG })

      const primeira = await chamada()
      expect(primeira.status).toBe(201)
      expect(primeira.body.perfil).toBe("admin")
      expect(primeira.body.criado).toBe(true)
      usuarioCriadoId = primeira.body.usuarioId
      projetoCriadoId = primeira.body.projetoId

      // Usuário foi criado SEM senha.
      const usuario = (
        await db
          .select({ passwordHash: usuarios.passwordHash })
          .from(usuarios)
          .where(eq(usuarios.id, usuarioCriadoId as number))
      ).at(0)
      expect(usuario?.passwordHash).toBeNull()

      const repetida = await chamada()
      expect(repetida.status).toBe(201)
      expect(repetida.body).toEqual({
        usuarioId: usuarioCriadoId,
        projetoId: projetoCriadoId,
        perfil: "admin",
        criado: false,
      })
    })

    it("e-mail já existente: não duplica, garante o vínculo admin", async () => {
      const resposta = await request(app.getHttpServer())
        .post("/api/provision/project")
        .set("Authorization", `Bearer ${provisionToken}`)
        .send({
          email: "alexandre@globaltecnologia.com.br",
          projetoNome: "Provision Teste",
          projetoSlug: SLUG,
        })
      expect(resposta.status).toBe(201)
      expect(resposta.body.criado).toBe(false)
      // O alexandre é admin do projeto provisionado.
      const vinculo = (
        await db
          .select({ perfil: projetosUsuarios.perfil })
          .from(projetosUsuarios)
          .where(
            and(
              eq(projetosUsuarios.projetoId, projetoCriadoId as number),
              eq(projetosUsuarios.usuarioId, resposta.body.usuarioId),
            ),
          )
      ).at(0)
      expect(vinculo?.perfil).toBe("admin")
    })
  })
})
