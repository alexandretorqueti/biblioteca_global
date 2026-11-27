// @vitest-environment node
/**
 * Teste FUNCIONAL do CRUD genérico da Vitrine IA (macro #10, subtarefa 3)
 * contra o ambiente real (API NestJS bootada + MySQL `projeto_8509`).
 *
 * Executa apenas com MySQL disponível (`MYSQL_HOST`), no padrão das suítes
 * `*.functional.spec.ts` do repositório (excluídas do `npm test` padrão;
 * rodadas separadamente no ambiente de integração). Cobre os critérios de
 * aceite na stack real:
 * - CRUD autenticado responde nas 10 tabelas do schema;
 * - `credenciaisCifradas`: aceita gravação (POST/PUT) e NUNCA aparece em
 *   listar/detalhar/criar/atualizar — mas fica gravada no banco (write-only);
 * - POST/PUT com campo de fluxo (pedidos.status, agentes_provisionados.
 *   tentativas/status/personalidade, configuracoes_whatsapp.statusPareamento,
 *   documentos.caminhoArmazenamento) → 400; sem o campo → escrita normal;
 * - RBAC nativo: visualizador lê (200) e NÃO escreve (POST/PUT/DELETE 403);
 *   operador/gerente/admin criam;
 * - outros slugs/projetos inalterados (comportamento padrão mantido —
 *   coberto também no spec unitário `vitrine-ia-escopo.spec.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Test } from "@nestjs/testing"
import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { eq } from "drizzle-orm"
import { projetos, projetosUsuarios, usuarios } from "../../../../../../database/schema"
import {
  agentesProvisionados,
  configuracoesWhatsapp,
  documentos,
  integracoesExternas,
  pedidos,
  planos,
} from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../project-db.factory"
import { SLUG_VITRINE_IA } from "../escopo/vitrine-ia.escopo"
import {
  criarUsuarioCore,
  loginNaApp,
  type PerfilNegocio,
} from "./fixtures/matriz-perfis.fixture"

/** Registro core criado para a limpeza (mesma forma do tracker da fixture). */
type UsuarioCoreCriado = { id: number; username: string }

const hasMysql = Boolean(process.env.MYSQL_HOST)

const RECURSOS = [
  "planos",
  "itens_faq",
  "metricas_destaque",
  "segmentos",
  "textos_vitrine",
  "pedidos",
  "documentos",
  "agentes_provisionados",
  "integracoes_externas",
  "configuracoes_whatsapp",
] as const

describe.skipIf(!hasMysql)("CRUD da Vitrine IA — garantias server-side (macro #10, subtarefa 3)", () => {
  let app: INestApplication
  let coreDb: CoreDb
  let pdb: ProjetoDb
  let projetoId: number
  let sufixo: string
  const usuariosCriados: UsuarioCoreCriado[] = []
  const tokens = {} as Record<PerfilNegocio, string>
  const ids: Record<string, number> = {}

  const SEDED = {
    nomeNegocio: "Barbearia Smoke Vitrine",
    nomeContato: "Rui Barbeiro",
    email: `smoke.${Date.now()}@example.com`,
    telefone: "11 98888-7777",
    ciclo: "mensal" as const,
    consentimentoLgpd: true,
  }

  function http(
    perfil: PerfilNegocio,
    method: "get" | "post" | "put" | "delete",
    path: string,
    body?: Record<string, unknown>,
  ) {
    const req = request(app.getHttpServer())[method](`/api/${SLUG_VITRINE_IA}/${path}`)
    const autenticado = req.set("Authorization", `Bearer ${tokens[perfil]}`)
    return body !== undefined ? autenticado.send(body) : autenticado
  }

  beforeAll(async () => {
    sufixo = `vtr-${Date.now()}`
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    coreDb = app.get<CoreDb>(CORE_DB)
    const factory = app.get<ProjectDbFactory>(PROJECT_DB_FACTORY)

    const projeto = (
      await coreDb.select({ id: projetos.id }).from(projetos).where(eq(projetos.slug, SLUG_VITRINE_IA))
    ).at(0)
    if (!projeto) {
      throw new Error(`pré-requisito ausente: projeto ${SLUG_VITRINE_IA} no core (seed/dashboard)`)
    }
    projetoId = Number(projeto.id)
    pdb = await factory.obter({ id: projetoId })
    // As migrations da subtarefa 1 precisam estar aplicadas no banco do projeto.
    const [linhaPlano] = await pdb
      .select({ id: planos.id })
      .from(planos)
      .orderBy(planos.id)
      .limit(1)
    ids.planoSeed = Number(linhaPlano?.id ?? 0)
    if (!ids.planoSeed) throw new Error("pré-requisito: planos vazio — rode npm run db:seed")

    for (const perfil of ["admin", "gerente", "operador", "visualizador"] as PerfilNegocio[]) {
      const usuario = await criarUsuarioCore(coreDb, usuariosCriados, `vt_${perfil}`, sufixo)
      await coreDb
        .insert(projetosUsuarios)
        .values({ projetoId, usuarioId: usuario.id, perfil })
      tokens[perfil] = await loginNaApp(app, usuario.username, projetoId)
    }
  }, 300_000)

  afterAll(async () => {
    if (app) {
      if (pdb) {
        // Limpeza FK-order pelos ids criados (nunca toca no seed existente).
        for (const key of [
          "configWhats",
          "integracao",
          "documento",
          "agente",
          "pedido",
          "plano",
        ] as const) {
          const id = Number(ids[key] ?? 0)
          if (!Number.isSafeInteger(id) || id <= 0) continue
          if (key === "configWhats") await pdb.delete(configuracoesWhatsapp).where(eq(configuracoesWhatsapp.id, id))
          if (key === "integracao") await pdb.delete(integracoesExternas).where(eq(integracoesExternas.id, id))
          if (key === "documento") await pdb.delete(documentos).where(eq(documentos.id, id))
          if (key === "agente") await pdb.delete(agentesProvisionados).where(eq(agentesProvisionados.id, id))
          if (key === "pedido") await pdb.delete(pedidos).where(eq(pedidos.id, id))
          if (key === "plano") await pdb.delete(planos).where(eq(planos.id, id))
        }
      }
      if (coreDb) {
        for (const u of usuariosCriados) {
          await coreDb.delete(projetosUsuarios).where(eq(projetosUsuarios.usuarioId, u.id))
          await coreDb.delete(usuarios).where(eq(usuarios.id, u.id))
        }
      }
      await app.close()
    }
  }, 180_000)

  it("CRUD autenticado responde nas 10 tabelas (GET listar)", async () => {
    for (const resource of RECURSOS) {
      const res = await http("admin", "get", resource)
      expect(res.status, `GET ${resource}`).toBe(200)
      expect(Array.isArray(res.body.items)).toBe(true)
    }
  })

  it("POST /planos cria registro (admin)", async () => {
    const res = await http("admin", "post", "planos", {
      nome: `Plano Smoke ${sufixo}`,
      precoMensal: "199.90",
      ativo: true,
    })
    expect(res.status).toBe(201)
    ids.plano = Number(res.body.id)
    expect(res.body.nome).toContain("Smoke")
  })

  it("POST /pedidos sem campos de fluxo → 201 com status default 'criado'", async () => {
    const res = await http("operador", "post", "pedidos", { ...SEDED, planoId: ids.planoSeed })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe("criado")
    ids.pedido = Number(res.body.id)
  })

  it("POST /pedidos com status no corpo → 400 (transição só pelo backend)", async () => {
    const res = await http("admin", "post", "pedidos", {
      ...SEDED,
      planoId: ids.planoSeed,
      status: "pago",
    })
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toMatch(/status/)
  })

  it("PUT /pedidos com pagamentoId → 400; sem campos de fluxo → 200", async () => {
    const bloqueado = await http("admin", "put", `pedidos/${ids.pedido}`, { pagamentoId: "MP-999" })
    expect(bloqueado.status).toBe(400)
    expect(String(bloqueado.body.message)).toMatch(/pagamento_id/)
    const ok = await http("gerente", "put", `pedidos/${ids.pedido}`, { telefone: "11 97777-6666" })
    expect(ok.status).toBe(200)
    expect(ok.body.telefone).toBe("11 97777-6666")
    expect(ok.body.status).toBe("criado")
  })

  it("POST /documentos sem fluxo → 201; PUT com caminhoArmazenamento/textoExtraido → 400", async () => {
    const criado = await http("operador", "post", "documentos", {
      pedidoId: ids.pedido,
      nomeOriginal: "manual.txt",
      mimeType: "text/plain",
      tipoConteudo: "txt",
    })
    expect(criado.status).toBe(201)
    ids.documento = Number(criado.body.id)
    const bloqueado = await http("admin", "put", `documentos/${ids.documento}`, {
      caminhoArmazenamento: "/bucket/manual.txt",
      textoExtraido: "conteúdo injetado",
    })
    expect(bloqueado.status).toBe(400)
    expect(String(bloqueado.body.message)).toMatch(/caminho_armazenamento.*texto_extraido|texto_extraido/)
  })

  it("credenciaisCifradas é write-only: POST/PUT aceitam, GET nunca devolve, banco guarda", async () => {
    const criado = await http("admin", "post", "integracoes_externas", {
      pedidoId: ids.pedido,
      nome: "CRM do Cliente",
      urlBase: "https://crm.example.com/api",
      tipoAutenticacao: "api_key",
      credenciaisCifradas: "AES:TOP-SECRET-1",
    })
    expect(criado.status).toBe(201)
    ids.integracao = Number(criado.body.id)
    expect(criado.body).not.toHaveProperty("credenciaisCifradas")

    const detalhe = await http("admin", "get", `integracoes_externas/${ids.integracao}`)
    expect(detalhe.status).toBe(200)
    expect(detalhe.body).not.toHaveProperty("credenciaisCifradas")
    expect(detalhe.body.nome).toBe("CRM do Cliente")

    const lista = await http("gerente", "get", "integracoes_externas")
    expect(lista.body.items.every((i: Record<string, unknown>) => !("credenciaisCifradas" in i))).toBe(true)

    const editado = await http("admin", "put", `integracoes_externas/${ids.integracao}`, {
      credenciaisCifradas: "AES:TOP-SECRET-2",
      urlBase: "https://crm.example.com/v2",
    })
    expect(editado.status).toBe(200)
    expect(editado.body).not.toHaveProperty("credenciaisCifradas")

    // A gravação aconteceu de verdade (write-only, não descartado).
    const [linhaBruta] = await pdb
      .select({ credenciais: integracoesExternas.credenciaisCifradas })
      .from(integracoesExternas)
      .where(eq(integracoesExternas.id, ids.integracao))
    expect(linhaBruta?.credenciais).toBe("AES:TOP-SECRET-2")
  })

  it("agentes_provisionados: criação sem fluxo → 201; PUT de fluxo → 400", async () => {
    const criado = await http("gerente", "post", "agentes_provisionados", {
      pedidoId: ids.pedido,
      nome: "Atendente Ana",
    })
    expect(criado.status).toBe(201)
    expect(criado.body.status).toBe("pendente")
    ids.agente = Number(criado.body.id)

    for (const corpo of [
      { status: "ativo" },
      { tentativas: 3 },
      { personalidade: { tom: "amigavel" } },
      { openclawAgenteId: "agente-x" },
    ]) {
      const res = await http("admin", "put", `agentes_provisionados/${ids.agente}`, corpo)
      expect(res.status, JSON.stringify(corpo)).toBe(400)
    }
    // sem campos de fluxo, update normal
    const ok = await http("admin", "put", `agentes_provisionados/${ids.agente}`, { nome: "Atendente Bia" })
    expect(ok.status).toBe(200)
    expect(ok.body.nome).toBe("Atendente Bia")
  })

  it("configuracoes_whatsapp: criação → 201 com default; PUT statusPareamento/ultimoQrGeradoEm → 400", async () => {
    const criado = await http("admin", "post", "configuracoes_whatsapp", {
      agenteId: ids.agente,
      alcance: "todos",
    })
    expect(criado.status).toBe(201)
    expect(criado.body.statusPareamento).toBe("pendente")
    ids.configWhats = Number(criado.body.id)

    const bloqueado = await http("admin", "put", `configuracoes_whatsapp/${ids.configWhats}`, {
      statusPareamento: "pareado",
    })
    expect(bloqueado.status).toBe(400)
    expect(String(bloqueado.body.message)).toMatch(/status_pareamento/)

    const bloqueadoQr = await http("admin", "put", `configuracoes_whatsapp/${ids.configWhats}`, {
      ultimoQrGeradoEm: "2026-11-27 12:00:00",
    })
    expect(bloqueadoQr.status).toBe(400)
  })

  it("RBAC nativo: visualizador lê (200) e não escreve (POST/PUT/DELETE 403)", async () => {
    const leitura = await http("visualizador", "get", "planos")
    expect(leitura.status).toBe(200)

    const criar = await http("visualizador", "post", "planos", {
      nome: `Plano Proibido ${sufixo}`,
      precoMensal: "1.00",
    })
    expect(criar.status).toBe(403)

    const editar = await http("visualizador", "put", `planos/${ids.plano}`, { nome: "X" })
    expect(editar.status).toBe(403)

    const excluir = await http("visualizador", "delete", `planos/${ids.plano}`)
    expect(excluir.status).toBe(403)
  })
})
