// @vitest-environment node
/**
 * Teste funcional da barreira BACKEND de dados sensíveis por perfil
 * (gestao-de-tarefas-global — macro #2, subtarefa 4; REQ-F-017):
 * `cpf`, `telefone` e `email` de colaboradores.
 *
 * Critérios cobertos (via API real + MySQL real, não front):
 * - operador e visualizador NÃO recebem cpf/telefone/email em nenhuma
 *   resposta (GET list e GET detalhar de colaboradores; GET de demais
 *   recursos também não expõe os campos);
 * - operador e visualizador NÃO gravam esses campos (POST/PUT rejeitados
 *   com 400 claro; PUT de campo não sensível continua permitido);
 * - admin e gerente leem e gravam os campos normalmente (create mantém os
 *   campos na resposta).
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
  colaboradores as colaboradoresProjeto,
  organizacoes as organizacoesProjeto,
} from "../../../../../../projects/gestao-de-tarefas-global/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import { PROJECT_DB_FACTORY, type ProjectDbFactory, type ProjetoDb } from "../project-db.factory"

const SLUG = "gestao-de-tarefas-global"
const SUFIXO = `sensivel-${Date.now()}`
const SENHA = "Sensivel#2026"
const hasMysql = Boolean(process.env.MYSQL_HOST)

type PerfilTeste = "admin" | "gerente" | "operador" | "visualizador"
const PERFIS: PerfilTeste[] = ["admin", "gerente", "operador", "visualizador"]
const SEM_ACESSO: PerfilTeste[] = ["operador", "visualizador"]
const COM_ACESSO: PerfilTeste[] = ["admin", "gerente"]

const CPF = "123.456.789-00"
const TELEFONE = "11 99999-0000"
const EMAIL = `alvo.${SUFIXO}@exemplo.com`

describe.skipIf(!hasMysql)("Campos sensíveis por perfil — barreira backend (funcional)", () => {
  let app: INestApplication
  let db: CoreDb
  let pdb: ProjetoDb
  let projetoId: number
  let orgId: number
  let alvoId: number
  const tokens = {} as Record<PerfilTeste, string>
  const usuarioIds: number[] = []

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

    await limparDadosProjeto()

    const [orgRow] = await pdb
      .insert(organizacoesProjeto)
      .values({ nome: `Org sensíveis ${SUFIXO}` })
      .$returningId()
    orgId = Number(orgRow!.id)

    // Colaborador-alvo com TODOS os dados sensíveis preenchidos.
    const [alvoRow] = await pdb
      .insert(colaboradoresProjeto)
      .values({
        organizacaoId: orgId,
        nome: `Alvo Sensível ${SUFIXO}`,
        email: EMAIL,
        telefone: TELEFONE,
        cpf: CPF,
        ativo: true,
      })
      .$returningId()
    alvoId = Number(alvoRow!.id)

    // Um usuário por perfil, cada um vinculado a um colaborador ativo próprio
    // (requisito do guard de tenancy); o perfil de acesso vem do pivot
    // projetos_usuarios do core.
    for (const perfil of PERFIS) {
      const usuarioId = await criarUsuario(`teste_sensivel_${perfil}`, perfil)
      await pdb.insert(colaboradoresProjeto).values({
        organizacaoId: orgId,
        nome: `Colaborador ${perfil} ${SUFIXO}`,
        email: `colab-${perfil}.${SUFIXO}@exemplo.com`,
        telefone: TELEFONE,
        cpf: CPF,
        ativo: true,
        usuarioId,
      })
      tokens[perfil] = await login(`teste_sensivel_${perfil}`)
    }
  }, 180_000)

  afterAll(async () => {
    if (app) {
      await limparDadosProjeto()
      await limparUsuarios()
      await app.close()
    }
  }, 120_000)

  async function criarUsuario(username: string, perfil: PerfilTeste): Promise<number> {
    const hash = await argon2.hash(SENHA, { type: argon2.argon2id })
    await db.insert(usuarios).values({
      username,
      email: `${username}@exemplo.com`,
      nome: `Usuário ${perfil} ${SUFIXO}`,
      passwordHash: hash,
      ativo: true,
    })
    const usuario = (
      await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, username))
    ).at(0)
    if (!usuario) throw new Error(`usuário ${username} não criado`)
    await db.insert(projetosUsuarios).values({ projetoId, usuarioId: usuario.id, perfil })
    usuarioIds.push(Number(usuario.id))
    return Number(usuario.id)
  }

  async function login(username: string): Promise<string> {
    const loginRes = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ identifier: username, password: SENHA, identifierType: "username", consentimentoAceito: true })
    expect(loginRes.status).toBe(201)
    const select = await request(app.getHttpServer())
      .post("/api/auth/select-project")
      .set("Authorization", `Bearer ${loginRes.body.refreshToken}`)
      .send({ projetoId })
    expect(select.status).toBe(201)
    return select.body.accessToken as string
  }

  function api(
    perfil: PerfilTeste,
    method: "get" | "post" | "put",
    path: string,
    body?: Record<string, unknown>,
  ) {
    const req = request(app.getHttpServer())[method](`/api/${SLUG}/${path}`)
    const autenticado = req.set("Authorization", `Bearer ${tokens[perfil]}`)
    return body !== undefined ? autenticado.send(body) : autenticado
  }

  async function limparUsuarios(): Promise<void> {
    for (const id of usuarioIds) {
      await db.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, id))
      await db.delete(usuarios).where(eq(usuarios.id, id))
    }
  }

  async function limparDadosProjeto(): Promise<void> {
    if (!pdb) return
    // Remove a organização deste teste e todos os colaboradores dela
    // (incl. criados via API durante os testes de escrita).
    const orgs = await pdb
      .select({ id: organizacoesProjeto.id })
      .from(organizacoesProjeto)
      .where(eq(organizacoesProjeto.nome, `Org sensíveis ${SUFIXO}`))
    const orgIds = orgs.map((o) => Number(o.id))
    if (orgIds.length > 0) {
      const colabs = await pdb
        .select({ id: colaboradoresProjeto.id })
        .from(colaboradoresProjeto)
        .where(inArray(colaboradoresProjeto.organizacaoId, orgIds))
      if (colabs.length > 0) {
        await pdb
          .delete(colaboradoresProjeto)
          .where(inArray(colaboradoresProjeto.id, colabs.map((c) => Number(c.id))))
      }
      await pdb
        .delete(organizacoesProjeto)
        .where(inArray(organizacoesProjeto.id, orgIds))
    }
  }

  // ==========================================================================
  // LEITURA
  // ==========================================================================

  it("admin e gerente recebem cpf/telefone/email no detalhar e na listagem", async () => {
    for (const perfil of COM_ACESSO) {
      const detalhe = await api(perfil, "get", `colaboradores/${alvoId}`)
      expect(detalhe.status, `${perfil} GET detalhar`).toBe(200)
      expect(detalhe.body.cpf).toBe(CPF)
      expect(detalhe.body.telefone).toBe(TELEFONE)
      expect(detalhe.body.email).toBe(EMAIL)

      const lista = await api(perfil, "get", "colaboradores?pageSize=100")
      expect(lista.status).toBe(200)
      const alvo = (lista.body.items as Array<Record<string, unknown>>).find(
        (i) => Number(i.id) === alvoId,
      )
      expect(alvo, `${perfil} deve ver o alvo na lista`).toBeTruthy()
      expect(alvo!.cpf).toBe(CPF)
      expect(alvo!.telefone).toBe(TELEFONE)
      expect(alvo!.email).toBe(EMAIL)
    }
  })

  it("operador e visualizador NÃO recebem cpf/telefone/email (detalhar e lista)", async () => {
    for (const perfil of SEM_ACESSO) {
      const detalhe = await api(perfil, "get", `colaboradores/${alvoId}`)
      expect(detalhe.status, `${perfil} GET detalhar`).toBe(200)
      expect(detalhe.body.id).toBe(alvoId)
      expect(detalhe.body.nome).toContain("Alvo Sensível")
      expect("cpf" in detalhe.body, `${perfil} não pode ver cpf`).toBe(false)
      expect("telefone" in detalhe.body, `${perfil} não pode ver telefone`).toBe(false)
      expect("email" in detalhe.body, `${perfil} não pode ver email`).toBe(false)

      const lista = await api(perfil, "get", "colaboradores?pageSize=100")
      expect(lista.status).toBe(200)
      const alvo = (lista.body.items as Array<Record<string, unknown>>).find(
        (i) => Number(i.id) === alvoId,
      )
      expect(alvo, `${perfil} ainda vê o registro (sem os campos)`).toBeTruthy()
      for (const campo of ["cpf", "telefone", "email"]) {
        expect(campo in alvo!, `${perfil}: lista não pode conter ${campo}`).toBe(false)
      }
      // Nenhum item da lista carrega os campos sensíveis.
      for (const item of lista.body.items as Array<Record<string, unknown>>) {
        expect("cpf" in item).toBe(false)
        expect("telefone" in item).toBe(false)
        expect("email" in item).toBe(false)
      }
    }
  })

  it("payload expandido (tarefas) não expõe os campos sensíveis para operador", async () => {
    const resposta = await api("operador", "get", "tarefas?pageSize=100")
    expect(resposta.status).toBe(200)
    const bruto = JSON.stringify(resposta.body)
    expect(bruto).not.toContain(CPF)
    expect(bruto).not.toContain(EMAIL)
  })

  // ==========================================================================
  // ESCRITA
  // ==========================================================================

  it("operador/visualizador NÃO gravam cpf/telefone/email — rejeitados pelo backend (update)", async () => {
    // operador: passa pelo RolesGuard mas cai na barreira de campo (400 claro).
    // visualizador: read-only no CRUD (RolesGuard → 403 em qualquer escrita).
    for (const perfil of SEM_ACESSO) {
      const esperado = perfil === "operador" ? 400 : 403
      const resposta = await api(perfil, "put", `colaboradores/${alvoId}`, {
        cpf: "999.888.777-66",
      })
      expect(resposta.status, `${perfil} PUT cpf`).toBe(esperado)
      if (esperado === 400) expect(JSON.stringify(resposta.body)).toContain("cpf")

      const resposta2 = await api(perfil, "put", `colaboradores/${alvoId}`, {
        telefone: "21 88888-7777",
        email: `invasao.${SUFIXO}@exemplo.com`,
      })
      expect(resposta2.status, `${perfil} PUT telefone+email`).toBe(esperado)
      if (esperado === 400) {
        expect(JSON.stringify(resposta2.body)).toContain("telefone")
        expect(JSON.stringify(resposta2.body)).toContain("email")
      }
    }
    // Nada foi gravado: admin confirma os valores originais.
    const conferido = await api("admin", "get", `colaboradores/${alvoId}`)
    expect(conferido.body.cpf).toBe(CPF)
    expect(conferido.body.telefone).toBe(TELEFONE)
    expect(conferido.body.email).toBe(EMAIL)
  })

  it("operador/visualizador NÃO gravam campos sensíveis no create — rejeitados", async () => {
    for (const perfil of SEM_ACESSO) {
      const esperado = perfil === "operador" ? 400 : 403
      const resposta = await api(perfil, "post", "colaboradores", {
        nome: `Criado por ${perfil} ${SUFIXO}`,
        email: `criado-${perfil}.${SUFIXO}@exemplo.com`,
        cpf: CPF,
      })
      expect(resposta.status, `${perfil} POST com cpf`).toBe(esperado)
      if (esperado === 400) expect(JSON.stringify(resposta.body)).toContain("cpf")
    }
  })

  it("operador pode atualizar campo NÃO sensível (update parcial neutro)", async () => {
    const resposta = await api("operador", "put", `colaboradores/${alvoId}`, {
      nome: `Alvo Renomeado ${SUFIXO}`,
    })
    expect([200, 204]).toContain(resposta.status)
    const detalhe = await api("admin", "get", `colaboradores/${alvoId}`)
    expect(detalhe.body.nome).toBe(`Alvo Renomeado ${SUFIXO}`)
    expect(detalhe.body.cpf).toBe(CPF)
  })

  it("admin e gerente leem e GRAVAM os campos normalmente (create mantém campos)", async () => {
    for (const perfil of COM_ACESSO) {
      const cpfPerfil = perfil === "admin" ? "111.222.333-44" : "555.666.777-88"
      const resposta = await api(perfil, "post", "colaboradores", {
        nome: `Novo por ${perfil} ${SUFIXO}`,
        email: `novo-${perfil}.${SUFIXO}@exemplo.com`,
        telefone: TELEFONE,
        cpf: cpfPerfil,
      })
      expect([200, 201], `${perfil} POST com campos sensíveis`).toContain(resposta.status)
      expect(resposta.body.cpf, "criação pelo admin/gerente mantém os campos").toBe(cpfPerfil)
      const novoId = Number(resposta.body.id)

      const update = await api(perfil, "put", `colaboradores/${novoId}`, {
        cpf: CPF,
        telefone: "31 77777-6666",
      })
      expect([200, 204]).toContain(update.status)

      const detalhe = await api(perfil, "get", `colaboradores/${novoId}`)
      expect(detalhe.body.cpf).toBe(CPF)
      expect(detalhe.body.telefone).toBe("31 77777-6666")
    }
  })

  it("após tudo, operador ainda não vê os campos gravados por admin", async () => {
    const lista = await api("operador", "get", "colaboradores?pageSize=100")
    expect(lista.status).toBe(200)
    const bruto = JSON.stringify(lista.body)
    expect(bruto).not.toContain(CPF)
    expect(bruto).not.toContain(EMAIL)
  })
})
