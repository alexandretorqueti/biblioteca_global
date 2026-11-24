// @vitest-environment node
/**
 * Fixtures reutilizáveis da matriz de permissões por perfil e organização
 * (gestao-de-tarefas-global — macro #2, subtarefa 6).
 *
 * Semeia, de forma determinística e com limpeza completa, o cenário canônico
 * dos critérios de aceite da macro:
 * - organizações A e B (banco do projeto projeto_<id>);
 * - usuários da plataforma (core) com perfil no pivot `projetos_usuarios`:
 *   master (biblioteca-global/admin), admin A, gerente A, operador A,
 *   visualizador A e admin B — cada usuário de negócio com um COLABORADOR
 *   ATIVO próprio vinculado por `usuario_id` (requisito do guard de tenancy);
 * - dados de negócio por organização: área, tag, tarefa aberta, tarefa
 *   FECHADA (status ≠ 'aberta', p/ bloqueio de edição) e colaborador-alvo
 *   com dados sensíveis (cpf/telefone/email).
 *
 * O módulo não boota a aplicação sozinho: `montarMatrizPerfis()` boota
 * AppModule (MySQL real via .env) e devolve app + tokens + ids. Usado pela
 * suíte `gestao-tarefas-global-matriz-perfis.functional.spec.ts` e
 * reaproveitável por futuras suítes do projeto (mesmo contrato de limpeza).
 */
import { expect } from "vitest"
import { Test } from "@nestjs/testing"
import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import argon2 from "argon2"
import { eq, inArray } from "drizzle-orm"
import {
  projetos,
  projetosUsuarios,
  usuarios,
} from "../../../../../../../database/schema"
import {
  anexos,
  areas,
  colaboradores as colaboradoresTabela,
  historicoTarefas,
  mensagensTarefa,
  notificacoes,
  organizacoes as organizacoesTabela,
  regrasRecorrencia,
  tags,
  tarefaTags,
  tarefas,
} from "../../../../../../../projects/gestao-de-tarefas-global/schema"
import { AppModule } from "../../../../app.module"
import { configureApp } from "../../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../../project-db.factory"

export const SLUG_GESTAO = "gestao-de-tarefas-global"
export const SLUG_MASTER = "biblioteca-global"

export type PerfilNegocio = "admin" | "gerente" | "operador" | "visualizador"

/** Perfis de negócio da organização A (ordem fixa p/ nomes determinísticos). */
export const PERFIS_A: PerfilNegocio[] = [
  "admin",
  "gerente",
  "operador",
  "visualizador",
]

export interface MatrizPerfisFixtures {
  app: INestApplication
  coreDb: CoreDb
  pdb: ProjetoDb
  /** id do projeto gestao-de-tarefas-global no core. */
  projetoId: number
  /** id do projeto biblioteca-global (master) no core. */
  projetoMasterId: number
  /** Organização A e B (id no banco do projeto). */
  orgA: number
  orgB: number
  /** Área e tag de cada organização. */
  area: { A: number; B: number }
  tag: { A: number; B: number }
  /** Tarefa aberta e tarefa FECHADA (status ≠ 'aberta') de A; aberta de B. */
  tarefaAbertaA: number
  tarefaFechadaA: number
  tarefaB: number
  /** Colaborador-alvo de A com cpf/telefone/email preenchidos. */
  alvoSensivelA: number
  /** Colaborador ativo vinculado a cada usuário (id no banco do projeto). */
  colabIdPorUsuario: Record<ColaboradorDono, number>
  /** Tokens de acesso por participante (login + select-project reais). */
  tokens: Record<Participante, string>
  /** CPF/telefone/email do alvo sensível (asserts de leitura/escrita). */
  sensiveis: { cpf: string; telefone: string; email: string }
  sufixo: string
}

/** Participantes fixos da matriz (5 usuários A-side + admin B + master). */
export type Participante =
  | "master"
  | "adminA"
  | "gerenteA"
  | "operadorA"
  | "visualizadorA"
  | "adminB"

/** Donos de colaboradores ativos vinculados (um por usuário da matriz). */
export type ColaboradorDono = Exclude<Participante, "master">

export const CPF_ALVO = "123.456.789-00"
export const TELEFONE_ALVO = "11 99999-0000"

const SENHA = "Matriz#2026"

interface UsuarioCoreCriado {
  id: number
  username: string
}

/**
 * Boota a aplicação e semeia o cenário completo. Retorna também `desmontar`
 * com a limpeza completa (FK-order) — sempre chamar no afterAll.
 */
export async function montarMatrizPerfis(): Promise<
  MatrizPerfisFixtures & { desmontar: () => Promise<void> }
> {
  const sufixo = `matriz-${Date.now()}`
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  configureApp(app)
  await app.init()
  const coreDb = app.get<CoreDb>(CORE_DB)
  const factory = app.get<ProjectDbFactory>(PROJECT_DB_FACTORY)

  const projeto = (
    await coreDb
      .select({ id: projetos.id })
      .from(projetos)
      .where(eq(projetos.slug, SLUG_GESTAO))
  ).at(0)
  if (!projeto) throw new Error(`pré-requisito ausente: projeto ${SLUG_GESTAO} no core`)
  const projetoId = Number(projeto.id)

  const projetoMaster = (
    await coreDb
      .select({ id: projetos.id })
      .from(projetos)
      .where(eq(projetos.slug, SLUG_MASTER))
  ).at(0)
  if (!projetoMaster)
    throw new Error(`pré-requisito ausente: projeto ${SLUG_MASTER} no core`)
  const projetoMasterId = Number(projetoMaster.id)

  const pdb = await factory.obter({ id: projetoId })

  const usuariosCriados: UsuarioCoreCriado[] = []
  const orgIds: number[] = []

  // ------------------------------------------------------------------
  // Organizações A e B
  // ------------------------------------------------------------------
  const [orgARow] = await pdb
    .insert(organizacoesTabela)
    .values({ nome: `Matriz Org A ${sufixo}` })
    .$returningId()
  const orgA = Number(orgARow!.id)
  const [orgBRow] = await pdb
    .insert(organizacoesTabela)
    .values({ nome: `Matriz Org B ${sufixo}` })
    .$returningId()
  const orgB = Number(orgBRow!.id)
  orgIds.push(orgA, orgB)

  // ------------------------------------------------------------------
  // Dados de negócio por organização
  // ------------------------------------------------------------------
  const area: Record<"A" | "B", number> = { A: 0, B: 0 }
  const tag: Record<"A" | "B", number> = { A: 0, B: 0 }
  for (const lado of ["A", "B"] as const) {
    const orgId = lado === "A" ? orgA : orgB
    const [areaRow] = await pdb
      .insert(areas)
      .values({ organizacaoId: orgId, nome: `Matriz Área ${lado} ${sufixo}` })
      .$returningId()
    area[lado] = Number(areaRow!.id)
    const [tagRow] = await pdb
      .insert(tags)
      .values({ organizacaoId: orgId, nome: `matriz-tag-${lado.toLowerCase()}-${sufixo}` })
      .$returningId()
    tag[lado] = Number(tagRow!.id)
  }

  // Colaborador-alvo de A com TODOS os dados sensíveis (critério 3).
  const [alvoRow] = await pdb
    .insert(colaboradoresTabela)
    .values({
      organizacaoId: orgA,
      nome: `Matriz Alvo Sensível ${sufixo}`,
      email: `alvo.${sufixo}@exemplo.com`,
      telefone: TELEFONE_ALVO,
      cpf: CPF_ALVO,
      ativo: true,
    })
    .$returningId()
  const alvoSensivelA = Number(alvoRow!.id)

  // Tarefas: uma aberta e uma FECHADA em A; uma aberta em B.
  const [tarefaAbertaARow] = await pdb
    .insert(tarefas)
    .values({
      organizacaoId: orgA,
      titulo: `Matriz Tarefa Aberta A ${sufixo}`,
      areaId: area.A,
      responsavelId: alvoSensivelA,
      criadoPorId: alvoSensivelA,
      status: "aberta",
    })
    .$returningId()
  const tarefaAbertaA = Number(tarefaAbertaARow!.id)

  const [tarefaFechadaARow] = await pdb
    .insert(tarefas)
    .values({
      organizacaoId: orgA,
      titulo: `Matriz Tarefa Fechada A ${sufixo}`,
      areaId: area.A,
      responsavelId: alvoSensivelA,
      criadoPorId: alvoSensivelA,
      status: "concluida",
      concluidaEm: new Date().toISOString().slice(0, 19).replace("T", " "),
    })
    .$returningId()
  const tarefaFechadaA = Number(tarefaFechadaARow!.id)

  const [tarefaBRow] = await pdb
    .insert(tarefas)
    .values({
      organizacaoId: orgB,
      titulo: `Matriz Tarefa B ${sufixo}`,
      areaId: area.B,
      responsavelId: alvoSensivelA, // id de A de propósito: só usado p/ satisfazer FK no seed
      criadoPorId: alvoSensivelA,
      status: "aberta",
    })
    .$returningId()
  const tarefaB = Number(tarefaBRow!.id)

  // ------------------------------------------------------------------
  // Usuários (core) + perfil no pivot + colaborador ativo vinculado
  // ------------------------------------------------------------------
  const tokens = {} as Record<Participante, string>
  const colabIdPorUsuario = {} as Record<ColaboradorDono, number>

  const participantesNegocio: Array<{
    participante: ColaboradorDono
    perfil: PerfilNegocio
    organizacaoId: number
  }> = [
    { participante: "adminA", perfil: "admin", organizacaoId: orgA },
    { participante: "gerenteA", perfil: "gerente", organizacaoId: orgA },
    { participante: "operadorA", perfil: "operador", organizacaoId: orgA },
    { participante: "visualizadorA", perfil: "visualizador", organizacaoId: orgA },
    { participante: "adminB", perfil: "admin", organizacaoId: orgB },
  ]

  for (const { participante, perfil, organizacaoId } of participantesNegocio) {
    const usuario = await criarUsuarioCore(coreDb, usuariosCriados, `mz_${participante}`, sufixo)
    await coreDb
      .insert(projetosUsuarios)
      .values({ projetoId, usuarioId: usuario.id, perfil })
    const [colabRow] = await pdb
      .insert(colaboradoresTabela)
      .values({
        organizacaoId,
        nome: `Matriz Colaborador ${participante} ${sufixo}`,
        email: `${participante}.${sufixo}@exemplo.com`,
        ativo: true,
        usuarioId: usuario.id,
      })
      .$returningId()
    colabIdPorUsuario[participante] = Number(colabRow!.id)
    tokens[participante] = await loginNaApp(app, usuario.username, projetoId)
  }

  // Master: admin do projeto biblioteca-global, SEM colaborador.
  const master = await criarUsuarioCore(coreDb, usuariosCriados, "mz_master", sufixo)
  await coreDb
    .insert(projetosUsuarios)
    .values({ projetoId: projetoMasterId, usuarioId: master.id, perfil: "admin" })
  tokens.master = await loginNaApp(app, master.username, projetoMasterId)

  async function desmontar(): Promise<void> {
    // 1) Banco do projeto: filhos → pais, apenas nas organizações da matriz.
    if (orgIds.length > 0) {
      const tarefaIds = (
        await pdb
          .select({ id: tarefas.id })
          .from(tarefas)
          .where(inArray(tarefas.organizacaoId, orgIds))
      ).map((t) => Number(t.id))
      if (tarefaIds.length > 0) {
        await pdb.delete(anexos).where(inArray(anexos.tarefaId, tarefaIds))
        await pdb.delete(historicoTarefas).where(inArray(historicoTarefas.tarefaId, tarefaIds))
        await pdb.delete(mensagensTarefa).where(inArray(mensagensTarefa.tarefaId, tarefaIds))
        await pdb.delete(tarefaTags).where(inArray(tarefaTags.tarefaId, tarefaIds))
      }
      await pdb.delete(notificacoes).where(inArray(notificacoes.organizacaoId, orgIds))
      await pdb.delete(tarefas).where(inArray(tarefas.organizacaoId, orgIds))
      await pdb.delete(regrasRecorrencia).where(inArray(regrasRecorrencia.organizacaoId, orgIds))
      await pdb.delete(tags).where(inArray(tags.organizacaoId, orgIds))
      await pdb.delete(areas).where(inArray(areas.organizacaoId, orgIds))
      await pdb
        .delete(colaboradoresTabela)
        .where(inArray(colaboradoresTabela.organizacaoId, orgIds))
      await pdb
        .delete(organizacoesTabela)
        .where(inArray(organizacoesTabela.id, orgIds))
    }
    // 2) Core: pivots e usuários criados.
    for (const u of usuariosCriados) {
      await coreDb.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, u.id))
      await coreDb.delete(usuarios).where(eq(usuarios.id, u.id))
    }
  }

  return {
    app,
    coreDb,
    pdb,
    projetoId,
    projetoMasterId,
    orgA,
    orgB,
    area,
    tag,
    tarefaAbertaA,
    tarefaFechadaA,
    tarefaB,
    alvoSensivelA,
    colabIdPorUsuario,
    tokens,
    sensiveis: { cpf: CPF_ALVO, telefone: TELEFONE_ALVO, email: `alvo.${sufixo}@exemplo.com` },
    sufixo,
    desmontar,
  }
}

/** Cria usuário global no core (senha fixa da matriz) e registra p/ limpeza. */
export async function criarUsuarioCore(
  coreDb: CoreDb,
  tracker: UsuarioCoreCriado[],
  prefixo: string,
  sufixo: string,
): Promise<UsuarioCoreCriado> {
  const username = `${prefixo}_${sufixo}`
  const hash = await argon2.hash(SENHA, { type: argon2.argon2id })
  await coreDb.insert(usuarios).values({
    username,
    email: `${username}@exemplo.com`,
    nome: `Usuário ${prefixo} ${sufixo}`,
    passwordHash: hash,
    ativo: true,
  })
  const linha = (
    await coreDb.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.username, username))
  ).at(0)
  if (!linha) throw new Error(`usuário ${username} não criado`)
  const criado = { id: Number(linha.id), username }
  tracker.push(criado)
  return criado
}

/** Login real + select-project (mesmo fluxo dos specs funcionais do projeto). */
export async function loginNaApp(
  app: INestApplication,
  username: string,
  projetoId: number,
): Promise<string> {
  const loginRes = await request(app.getHttpServer())
    .post("/api/auth/login")
    .send({
      identifier: username,
      password: SENHA,
      identifierType: "username",
      consentimentoAceito: true,
    })
  expect(loginRes.status, `login ${username}`).toBe(201)
  const selectRes = await request(app.getHttpServer())
    .post("/api/auth/select-project")
    .set("Authorization", `Bearer ${loginRes.body.refreshToken}`)
    .send({ projetoId })
  expect(selectRes.status, `select-project ${username}`).toBe(201)
  const token = selectRes.body.accessToken as string
  if (!token) throw new Error(`token ausente no login de ${username}`)
  return token
}

/** Cliente HTTP autenticado no CRUD do projeto (paths relativos a /api/<slug>/). */
export function cliente(
  app: INestApplication,
  token: string,
  method: "get" | "post" | "put" | "delete",
  path: string,
  body?: Record<string, unknown>,
) {
  const req = request(app.getHttpServer())[method](`/api/${SLUG_GESTAO}/${path}`)
  const autenticado = req.set("Authorization", `Bearer ${token}`)
  return body !== undefined ? autenticado.send(body) : autenticado
}

export const SENHA_MATRIZ = SENHA
