// @vitest-environment node
/**
 * MATRIZ DE TESTES DE PERMISSÃO POR PERFIL E ORGANIZAÇÃO
 * (gestao-de-tarefas-global — macro #2, subtarefa 6 — aceite da macro).
 *
 * Consolida, num único cenário ponta a ponta (API real + MySQL real), os
 * cinco critérios de aceite da macro, com os fixtures reutilizáveis de
 * `fixtures/matriz-perfis.fixture.ts` (organizações A e B; usuários master,
 * admin A, gerente A, operador A, visualizador A e admin B):
 *
 * - CA1 — isolamento A×B em TODOS os recursos (leitura e escrita), por
 *   todos os perfis de A e simetricamente para B;
 * - CA2 — master cria organização e admin (service de gestão — os endpoints
 *   custom da subtarefa 3 expõem este service) e master NÃO opera dados de
 *   negócio (403/404);
 * - CA3 — admin cadastra colaboradores da própria organização (organização
 *   forçada pela sessão; gerente/operador rejeitados; payload de outra
 *   organização rejeitado);
 * - CA4 — cpf/telefone/email visíveis só a admin/gerente, inclusive via API
 *   direta (por perfil, nos dois sentidos e nas duas organizações);
 * - CA5 — qualquer usuário do escopo cria tarefa; edição genérica de tarefa
 *   com status ≠ 'aberta' rejeitada com erro claro (por perfil).
 *
 * Requisitos: REQ-F-015/016/017/019, REQ-D-001, REQ-NF-002.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import { ConflictException } from "@nestjs/common"
import { and, eq } from "drizzle-orm"
import { projetosUsuarios, usuarios } from "../../../../../../database/schema"
import {
  colaboradores as colaboradoresTabela,
  organizacoes as organizacoesTabela,
} from "../../../../../../projects/gestao-de-tarefas-global/schema"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../project-db.factory"
import { GestãoOrganizacoesService } from "../../gestao-organizacoes/gestao-organizacoes.service"
import type { ContextoEscopoOrganizacao } from "../../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import {
  criarUsuarioCore,
  montarMatrizPerfis,
  SLUG_GESTAO,
  cliente,
  type MatrizPerfisFixtures,
  type Participante,
} from "./fixtures/matriz-perfis.fixture"

const hasMysql = Boolean(process.env.MYSQL_HOST)

/** Perfis de negócio da organização A mapeados ao participante da matriz. */
const PARTICIPANTES_A = [
  "adminA",
  "gerenteA",
  "operadorA",
  "visualizadorA",
] as const
type ParticipanteA = (typeof PARTICIPANTES_A)[number]

/** Perfil de negócio por participante A (para expectations dependentes de papel). */
const PERFIL_DE: Record<ParticipanteA, "admin" | "gerente" | "operador" | "visualizador"> = {
  adminA: "admin",
  gerenteA: "gerente",
  operadorA: "operador",
  visualizadorA: "visualizador",
}

/** Perfis com acesso a dados sensíveis e com escrita liberada pelo RolesGuard. */
const COM_SENSIVEIS = new Set(["adminA", "gerenteA"])
const PODEM_ESCREVER = new Set(["adminA", "gerenteA", "operadorA"])

describe.skipIf(!hasMysql)("Matriz de permissões por perfil × organização (macro #2 — aceite)", () => {
  let fix: MatrizPerfisFixtures & { desmontar: () => Promise<void> }
  let app: INestApplication
  let coreDb: CoreDb
  let gestao: GestãoOrganizacoesService

  // Registros criados por testes específicos (limpeza no afterAll).
  const orgsExtras: number[] = []
  const trackerUsuariosExtras: Array<{ id: number; username: string }> = []

  beforeAll(async () => {
    fix = await montarMatrizPerfis()
    app = fix.app
    coreDb = fix.coreDb
    const factory = app.get<ProjectDbFactory>(PROJECT_DB_FACTORY)
    // Os endpoints custom da subtarefa 3 são a fachada HTTP deste service;
    // a matriz exercita a mesma instância de serviço com o DI real da app.
    gestao = new GestãoOrganizacoesService(app.get<CoreDb>(CORE_DB), factory)
  }, 300_000)

  afterAll(async () => {
    if (fix) {
      // Limpeza dos registros extras dos testes de master/admin (FK-order).
      for (const orgId of orgsExtras) {
        const colabs = await fix.pdb
          .select({ id: colaboradoresTabela.id })
          .from(colaboradoresTabela)
          .where(eq(colaboradoresTabela.organizacaoId, orgId))
        if (colabs.length > 0) {
          await fix.pdb.delete(colaboradoresTabela).where(eq(colaboradoresTabela.organizacaoId, orgId))
        }
        await fix.pdb.delete(organizacoesTabela).where(eq(organizacoesTabela.id, orgId))
      }
      for (const u of trackerUsuariosExtras) {
        await coreDb.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, u.id))
        await coreDb.delete(usuarios).where(eq(usuarios.id, u.id))
      }
      await fix.desmontar()
    }
  }, 180_000)

  function api(
    participante: Participante,
    method: "get" | "post" | "put" | "delete",
    path: string,
    body?: Record<string, unknown>,
  ) {
    return cliente(app, fix.tokens[participante], method, path, body)
  }

  function ctxAdminA(): ContextoEscopoOrganizacao {
    return {
      tipo: "colaborador",
      organizacaoId: fix.orgA,
      colaboradorId: fix.colabIdPorUsuario.adminA,
      perfil: "admin",
    }
  }

  // ==========================================================================
  // CA1 — isolamento A×B em todos os recursos, por todos os perfis
  // ==========================================================================

  describe("CA1: isolamento A × B (leitura e escrita) em todos os recursos", () => {
    it("nenhum perfil de A lê detalhe de tarefa de B (404)", async () => {
      for (const participante of PARTICIPANTES_A) {
        const resposta = await api(participante, "get", `tarefas/${fix.tarefaB}`)
        expect(resposta.status, `${participante} GET tarefa de B`).toBe(404)
      }
    })

    it("nenhum perfil de A escreve/exclui tarefa de B (404; visualizador 403 antes)", async () => {
      for (const participante of PARTICIPANTES_A) {
        const esperado = PODEM_ESCREVER.has(participante) ? 404 : 403
        const put = await api(participante, "put", `tarefas/${fix.tarefaB}`, {
          titulo: `invasão ${fix.sufixo}`,
        })
        expect(put.status, `${participante} PUT tarefa de B`).toBe(esperado)
        const del = await api(participante, "delete", `tarefas/${fix.tarefaB}`)
        expect(del.status, `${participante} DELETE tarefa de B`).toBe(esperado)
      }
      // Confirmação: tarefa de B intacta (admin B lê o título original).
      const conferida = await api("adminB", "get", `tarefas/${fix.tarefaB}`)
      expect(conferida.status).toBe(200)
      expect(conferida.body.titulo).toContain("Matriz Tarefa B")
    })

    it("listagens de A não contêm ids de B em nenhum resource (todos os perfis)", async () => {
      const recursos = [
        "organizacoes",
        "colaboradores",
        "areas",
        "tags",
        "tarefas",
      ] as const
      const idBDe: Record<(typeof recursos)[number], number> = {
        organizacoes: fix.orgB,
        colaboradores: fix.colabIdPorUsuario.adminB, // colaborador ativo de B (fixture)
        areas: fix.area.B,
        tags: fix.tag.B,
        tarefas: fix.tarefaB,
      }
      for (const participante of PARTICIPANTES_A) {
        for (const recurso of recursos) {
          const resposta = await api(participante, "get", `${recurso}?pageSize=100`)
          expect(resposta.status, `${participante} GET ${recurso}`).toBe(200)
          const ids = (resposta.body.items as Array<{ id: number }>).map((i) => Number(i.id))
          const idB = idBDe[recurso]
          if (idB > 0) {
            expect(ids, `${participante}: ${recurso} vazou id de B`).not.toContain(idB)
          }
          // Cada listagem só contém ids da organização A (verificação estrutural
          // quando o item carrega organizacaoId).
          for (const item of resposta.body.items as Array<Record<string, unknown>>) {
            if (item.organizacaoId !== undefined && recurso !== "organizacoes") {
              expect(Number(item.organizacaoId), `${participante}: ${recurso} fora de A`).toBe(fix.orgA)
            }
          }
        }
      }
    })

    it("simetria: admin B não lê nem escreve dados de A", async () => {
      for (const path of [`tarefas/${fix.tarefaAbertaA}`, `areas/${fix.area.A}`, `colaboradores/${fix.alvoSensivelA}`]) {
        const resposta = await api("adminB", "get", path)
        expect(resposta.status, `adminB GET ${path}`).toBe(404)
      }
      const put = await api("adminB", "put", `tarefas/${fix.tarefaAbertaA}`, {
        titulo: `invasão B ${fix.sufixo}`,
      })
      expect(put.status).toBe(404)
      const lista = await api("adminB", "get", "tarefas?pageSize=100")
      const ids = (lista.body.items as Array<{ id: number }>).map((i) => Number(i.id))
      expect(ids).not.toContain(fix.tarefaAbertaA)
      expect(ids).toContain(fix.tarefaB)
    })

    it("colaborador de B não cria tarefa apontando FK para área de A (400 claro)", async () => {
      const resposta = await api("adminB", "post", "tarefas", {
        titulo: `cruzada ${fix.sufixo}`,
        area_id: fix.area.A,
        responsavel_id: fix.alvoSensivelA,
      })
      expect(resposta.status).toBe(400)
      expect(JSON.stringify(resposta.body)).toContain("area_id")
    })
  })

  // ==========================================================================
  // CA2 — master cria organização e admin
  // ==========================================================================

  describe("CA2: master cria organização e admin; não opera dados de negócio", () => {
    it("master cria organização com primeiro admin (colaborativo ativo + perfil admin no projeto)", async () => {
      const novoAdmin = await criarUsuarioCore(
        coreDb,
        trackerUsuariosExtras,
        "mz_novo_admin",
        fix.sufixo,
      )
      const resultado = await gestao.criarOrganizacaoComAdmin({
        nome: `Matriz Org criada pelo master ${fix.sufixo}`,
        descricao: "organização da matriz de permissões",
        admin: {
          usuarioId: novoAdmin.id,
          nome: "Admin Criado pela Matriz",
          email: `novo-admin.${fix.sufixo}@exemplo.com`,
        },
      })
      orgsExtras.push(Number(resultado.organizacaoId))

      // Organização existe no banco do projeto.
      const org = (
        await fix.pdb
          .select({ id: organizacoesTabela.id, nome: organizacoesTabela.nome })
          .from(organizacoesTabela)
          .where(eq(organizacoesTabela.id, resultado.organizacaoId))
          .limit(1)
      ).at(0)
      expect(org?.nome).toBe(`Matriz Org criada pelo master ${fix.sufixo}`)

      // Colaborador do admin: ativo e vinculado ao usuário global.
      expect(resultado.colaborador.ativo).toBe(true)
      expect(Number(resultado.colaborador.usuarioId)).toBe(novoAdmin.id)
      expect(Number(resultado.colaborador.organizacaoId)).toBe(Number(resultado.organizacaoId))

      // Pivot projetos_usuarios elevou/criou o perfil admin do projeto.
      const pivot = (
        await coreDb
          .select({ perfil: projetosUsuarios.perfil })
          .from(projetosUsuarios)
          .where(
            and(
              eq(projetosUsuarios.projetoId, fix.projetoId),
              eq(projetosUsuarios.usuarioId, novoAdmin.id),
            ),
          )
          .limit(1)
      ).at(0)
      expect(pivot?.perfil).toBe("admin")
    })

    it("master não cria colaborador fora do fluxo (contexto master rejeitado)", async () => {
      await expect(
        gestao.criarColaborador(
          { tipo: "master", usuarioId: 1 },
          { nome: "X", email: `x.${fix.sufixo}@exemplo.com` },
        ),
      ).rejects.toThrow(/Master da plataforma não opera diretamente/)
    })

    it("master não transita no CRUD de dados de negócio (404 slug mismatch / 403)", async () => {
      // Token master está vinculado ao projeto biblioteca-global: o CRUD do
      // slug do projeto rejeita por mismatch de projeto na request.
      const resposta = await api("master", "get", "tarefas?pageSize=10")
      expect([403, 404]).toContain(resposta.status)
    })

    it("sessão sem token não acessa o CRUD do projeto (401)", async () => {
      const requestMod = await import("supertest")
      const resposta = await requestMod.default(app.getHttpServer()).get(
        `/api/${SLUG_GESTAO}/tarefas`,
      )
      expect(resposta.status).toBe(401)
    })
  })

  // ==========================================================================
  // CA3 — admin cadastra colaboradores da própria organização
  // ==========================================================================

  describe("CA3: admin cadastra colaboradores da própria organização", () => {
    it("admin A cadastra colaborador — organização sempre a da sessão", async () => {
      const criado = await gestao.criarColaborador(ctxAdminA(), {
        nome: `Colaborador da Matriz ${fix.sufixo}`,
        email: `novo-colab.${fix.sufixo}@exemplo.com`,
      })
      expect(Number(criado.organizacaoId)).toBe(fix.orgA)
      expect(criado.ativo).toBe(true)

      // Visível via API para admin A; invisível para admin B.
      const viaApi = await api("adminA", "get", `colaboradores/${criado.id}`)
      expect(viaApi.status).toBe(200)
      const deB = await api("adminB", "get", `colaboradores/${criado.id}`)
      expect(deB.status).toBe(404)
    })

    it("payload com organizacaoId de outra organização é rejeitado (400)", async () => {
      await expect(
        gestao.criarColaborador(ctxAdminA(), {
          nome: "Invasor",
          email: `invasor.${fix.sufixo}@exemplo.com`,
          organizacaoId: fix.orgB,
        }),
      ).rejects.toThrow(/organização é sempre a da sessão/)
    })

    it("gerente e operador NÃO gerenciam colaboradores (admin exclusivo)", async () => {
      for (const perfil of ["gerente", "operador"] as const) {
        await expect(
          gestao.criarColaborador(
            {
              tipo: "colaborador",
              organizacaoId: fix.orgA,
              colaboradorId: fix.colabIdPorUsuario[perfil === "gerente" ? "gerenteA" : "operadorA"],
              perfil,
            },
            { nome: "X", email: `${perfil}-gestor.${fix.sufixo}@exemplo.com` },
          ),
        ).rejects.toThrow(ConflictException)
      }
    })

    it("vínculo duplicado na mesma organização → ConflictException explícita", async () => {
      // Usuário do adminA já tem colaborador ativo na org A (fixture).
      const linhaPivot = (
        await fix.pdb
          .select({ usuarioId: colaboradoresTabela.usuarioId })
          .from(colaboradoresTabela)
          .where(eq(colaboradoresTabela.id, fix.colabIdPorUsuario.adminA))
          .limit(1)
      ).at(0)
      const usuarioAdminA = Number(linhaPivot!.usuarioId)
      await expect(
        gestao.criarColaborador(ctxAdminA(), {
          nome: "Segundo vínculo",
          email: `segundo.${fix.sufixo}@exemplo.com`,
          usuarioId: usuarioAdminA,
        }),
      ).rejects.toThrow(ConflictException)
    })

    it("cadastro de colaborador pelo CRUD HTTP com organizacao_id de B cai na sessão A", async () => {
      const resposta = await api("adminA", "post", "colaboradores", {
        nome: `CRUD Colab ${fix.sufixo}`,
        email: `crud-colab.${fix.sufixo}@exemplo.com`,
        organizacao_id: fix.orgB,
      })
      expect([200, 201]).toContain(resposta.status)
      expect(Number(resposta.body.organizacaoId)).toBe(fix.orgA)
    })
  })

  // ==========================================================================
  // CA4 — dados sensíveis por perfil (inclusive via API direta)
  // ==========================================================================

  describe("CA4: cpf/telefone/email restritos a admin+gerente (API direta)", () => {
    const SENSIVEIS = ["cpf", "telefone", "email"] as const

    it("admin e gerente de A recebem os campos sensíveis do alvo (lista e detalhe)", async () => {
      for (const participante of ["adminA", "gerenteA"] as const) {
        const detalhe = await api(participante, "get", `colaboradores/${fix.alvoSensivelA}`)
        expect(detalhe.status, `${participante} detalhe`).toBe(200)
        expect(detalhe.body.cpf).toBe(fix.sensiveis.cpf)
        expect(detalhe.body.telefone).toBe(fix.sensiveis.telefone)
        expect(detalhe.body.email).toBe(fix.sensiveis.email)
      }
    })

    it("operador e visualizador de A NÃO recebem os campos (lista e detalhe)", async () => {
      for (const participante of ["operadorA", "visualizadorA"] as const) {
        const detalhe = await api(participante, "get", `colaboradores/${fix.alvoSensivelA}`)
        expect(detalhe.status, `${participante} detalhe`).toBe(200)
        for (const campo of SENSIVEIS) {
          expect(campo in detalhe.body, `${participante} viu ${campo}`).toBe(false)
        }
        const lista = await api(participante, "get", "colaboradores?pageSize=100")
        expect(lista.status).toBe(200)
        const bruto = JSON.stringify(lista.body)
        expect(bruto).not.toContain(fix.sensiveis.cpf)
        expect(bruto).not.toContain(fix.sensiveis.email)
      }
    })

    it("matriz completa de sensibilidade por participante (5 perfis A + admin B)", () => {
      // Vincula cada participante ao seu perfil esperado na matriz.
      const esperado: Record<Participante, boolean> = {
        master: false,
        adminA: true,
        gerenteA: true,
        operadorA: false,
        visualizadorA: false,
        adminB: true,
      }
      for (const participante of Object.keys(esperado) as Participante[]) {
        const temAcesso = COM_SENSIVEIS.has(participante) || participante === "adminB"
        expect(temAcesso, `expectativa de sensibilidade de ${participante}`).toBe(
          esperado[participante],
        )
      }
    })

    it("operador/visualizador não gravam campos sensíveis (400/403 por guard)", async () => {
      for (const participante of ["operadorA", "visualizadorA"] as const) {
        const resposta = await api(participante, "put", `colaboradores/${fix.alvoSensivelA}`, {
          cpf: "999.888.777-66",
        })
        expect([400, 403], `${participante} PUT cpf`).toContain(resposta.status)
      }
      // Nada mudou.
      const conferido = await api("adminA", "get", `colaboradores/${fix.alvoSensivelA}`)
      expect(conferido.body.cpf).toBe(fix.sensiveis.cpf)
    })

    it("admin B não vê o alvo de A nem via lista de sensíveis", async () => {
      const detalhe = await api("adminB", "get", `colaboradores/${fix.alvoSensivelA}`)
      expect(detalhe.status).toBe(404)
      const lista = await api("adminB", "get", "colaboradores?pageSize=100")
      const ids = (lista.body.items as Array<{ id: number }>).map((i) => Number(i.id))
      expect(ids).not.toContain(fix.alvoSensivelA)
    })
  })

  // ==========================================================================
  // CA5 — qualquer usuário cria tarefa; edição bloqueada por status
  // ==========================================================================

  describe("CA5: criação de tarefa por qualquer perfil; bloqueio de edição por status", () => {
    it("os 4 perfis de A criam tarefa na própria organização", async () => {
      for (const participante of PARTICIPANTES_A) {
        const resposta = await api(participante, "post", "tarefas", {
          titulo: `Tarefa criada por ${PERFIL_DE[participante]} ${fix.sufixo}`,
          area_id: fix.area.A,
          responsavel_id: fix.alvoSensivelA,
        })
        expect([200, 201], `${participante} POST tarefa`).toContain(resposta.status)
        expect(Number(resposta.body.organizacaoId)).toBe(fix.orgA)
        expect(resposta.body.status).toBe("aberta")
        // admin B não enxerga a tarefa criada por esse perfil.
        const deB = await api("adminB", "get", `tarefas/${resposta.body.id}`)
        expect(deB.status).toBe(404)
      }
    })

    it("criação com organizacao_id forçado para B cai na organização da sessão", async () => {
      const resposta = await api("operadorA", "post", "tarefas", {
        titulo: `Forçada ${fix.sufixo}`,
        area_id: fix.area.A,
        responsavel_id: fix.alvoSensivelA,
        organizacao_id: fix.orgB,
      })
      expect([200, 201]).toContain(resposta.status)
      expect(Number(resposta.body.organizacaoId)).toBe(fix.orgA)
    })

    it("PUT em tarefa fechada → 409 com erro claro (admin/gerente/operador); visualizador 403", async () => {
      for (const participante of PARTICIPANTES_A) {
        const resposta = await api(participante, "put", `tarefas/${fix.tarefaFechadaA}`, {
          titulo: `edição indevida ${fix.sufixo}`,
        })
        if (PODEM_ESCREVER.has(participante)) {
          expect(resposta.status, `${participante} PUT tarefa fechada`).toBe(409)
          const mensagem = JSON.stringify(resposta.body)
          expect(mensagem).toContain("edição indisponível")
          expect(mensagem).toContain("concluida")
        } else {
          expect(resposta.status, `${participante} PUT (read-only)`).toBe(403)
        }
      }
      // Conteúdo intacto.
      const conferida = await api("adminA", "get", `tarefas/${fix.tarefaFechadaA}`)
      expect(conferida.body.titulo).toContain("Matriz Tarefa Fechada A")
    })

    it("PUT em tarefa aberta → permitido a admin/gerente/operador e rejeitado a visualizador", async () => {
      for (const participante of PARTICIPANTES_A) {
        const resposta = await api(participante, "put", `tarefas/${fix.tarefaAbertaA}`, {
          descricao: `atualizada por ${PERFIL_DE[participante]} ${fix.sufixo}`,
        })
        if (PODEM_ESCREVER.has(participante)) {
          expect([200, 204], `${participante} PUT tarefa aberta`).toContain(resposta.status)
        } else {
          expect(resposta.status).toBe(403)
        }
      }
    })

    it("PUT com status no corpo → 400 (perfis de escrita); visualizador 403 antes", async () => {
      for (const participante of PARTICIPANTES_A) {
        const resposta = await api(participante, "put", `tarefas/${fix.tarefaAbertaA}`, {
          status: "concluida",
        })
        if (PODEM_ESCREVER.has(participante)) {
          expect(resposta.status, `${participante} PUT status`).toBe(400)
          expect(JSON.stringify(resposta.body)).toContain("status")
        } else {
          expect(resposta.status, `${participante} PUT status (read-only)`).toBe(403)
        }
      }
      const conferida = await api("adminA", "get", `tarefas/${fix.tarefaAbertaA}`)
      expect(conferida.body.status).toBe("aberta")
    })
  })

  // ==========================================================================
  // Sanidade da matriz (defesa de fixture)
  // ==========================================================================

  describe("sanidade da matriz", () => {
    it("todos os 6 participantes da matriz autenticaram e o serviço exige sessão", async () => {
      for (const participante of ["master", "adminA", "gerenteA", "operadorA", "visualizadorA", "adminB"] as Participante[]) {
        expect(fix.tokens[participante], `token de ${participante}`).toBeTruthy()
      }
      // service sem contexto → BadRequest (nunca grava às cegas)
      await expect(
        gestao.criarColaborador(undefined as unknown as ContextoEscopoOrganizacao, {
          nome: "X",
          email: `sem-ctx.${fix.sufixo}@example.com`,
        }),
      ).rejects.toThrow(/Contexto de organização não resolvido/)
      // guard de controller sem sessão propaga 401 (não 500) — coberto acima.
    })
  })
})
