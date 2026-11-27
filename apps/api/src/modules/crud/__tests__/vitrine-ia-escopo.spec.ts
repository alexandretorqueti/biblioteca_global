// @vitest-environment node
/**
 * Unit tests da extensão de escopo do CRUD genérico para o projeto
 * `vitrine-ia-loja-de-atendentes-virtuais` (macro #10, subtarefa 3).
 *
 * Cobre, sem MySQL (db fake + registry estático no padrão de
 * `gestao-tarefas-global-escopo.spec.ts`):
 * - `credenciaisCifradas` write-only: create/update ACEITAM o campo, e a
 *   chave sai de toda resposta (listar/detalhar/criar/atualizar);
 * - campos de fluxo (pedidos/documentos/agentes_provisionados/
 *   configuracoes_whatsapp): POST/PUT com a chave → 400 claro, ANTES de
 *   abrir conexão; sem a chave, escrita normal;
 * - RBAC visualizador: a regra nativa da plataforma (service recusa criar;
 *   controller exige @Roles admin/gerente/operador em PUT/DELETE e libera
 *   GET) — comprovada por teste, sem alteração na plataforma;
 * - extensão keyed por slug: outro projeto com as mesmas tabelas mantém o
 *   comportamento 100% inalterado;
 * - CRUD genérico responde pelas 10 tabelas do schema (listar/detalhar).
 */
import { describe, expect, it } from "vitest"
import { BadRequestException, ForbiddenException, type ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { ConfigService } from "@nestjs/config"
import { coletarTabelas } from "@biblioteca-global/schema-tools"
import * as schemaVitrine from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import {
  CAMPOS_DE_FLUXO_POR_TABELA,
  VitrineIaEscopo,
  SLUG_VITRINE_IA,
} from "../escopo/vitrine-ia.escopo"
import {
  CRUD_ESCOPO_EXTENSIONS,
  type ContextoEscopoCrud,
  type ExtensaoEscopoCrud,
} from "../escopo/escopo-crud.extension"
import { CrudService } from "../crud.service"
import { CrudController } from "../crud.controller"
import { RolesGuard } from "../../../common/guards/roles.guard"
import { ROLES_KEY } from "../../../common/decorators/roles.decorator"
import { RealtimeService } from "../../realtime/realtime.service"
import type { ProjectDbFactory, ProjetoDb } from "../project-db.factory"
import type { SchemaRegistry } from "../schema-registry"
import type { MySqlTable } from "drizzle-orm/mysql-core"

const tabelas = coletarTabelas(schemaVitrine) as Record<string, MySqlTable>
const extensao: ExtensaoEscopoCrud = new VitrineIaEscopo()
const ctx: ContextoEscopoCrud = { organizacaoId: 0, colaboradorId: 0, perfil: "sessao" }

/** As 10 entidades do plano macro #10 (nomes de tabela = resources). */
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

function linhaBase(resource: string): Record<string, unknown> {
  const comum: Record<string, unknown> = { id: 1 }
  switch (resource) {
    case "integracoes_externas":
      return {
        ...comum,
        pedidoId: 5,
        nome: "API CRM",
        urlBase: "https://crm.example.com",
        tipoAutenticacao: "api_key",
        credenciaisCifradas: "AES:NUNCA-EXPOR",
        somenteLeitura: true,
        ativo: true,
      }
    case "pedidos":
      return { ...comum, nomeNegocio: "Barbearia X", status: "criado", ciclo: "mensal" }
    case "agentes_provisionados":
      return { ...comum, pedidoId: 5, status: "pendente", tentativas: 0 }
    default:
      return comum
  }
}

// ============================================================================
// Extensão — regras puras (sem service)
// ============================================================================

describe("VitrineIaEscopo — registro e contexto", () => {
  it("slug da extensão", () => {
    expect(extensao.slug).toBe(SLUG_VITRINE_IA)
  })

  it("sessão sem escopo organizacional (guard não atua na vitrine) → contexto neutro, sem 403", () => {
    expect(() => extensao.contextoDaSessao(undefined)).not.toThrow()
    expect(extensao.contextoDaSessao(undefined)).toEqual({
      organizacaoId: 0,
      colaboradorId: 0,
      perfil: "sessao",
    })
  })

  it("sem restrição row-level (projeto single-tenant) e sem bloqueio de operação", () => {
    for (const resource of RECURSOS) {
      expect(extensao.condicaoLeitura(resource, tabelas[resource]!, ctx)).toBeUndefined()
      expect(extensao.operacaoBloqueada(resource, "create")).toBeUndefined()
      expect(extensao.operacaoBloqueada(resource, "update")).toBeUndefined()
      expect(extensao.operacaoBloqueada(resource, "delete")).toBeUndefined()
    }
  })

  it("não libera perfis adicionais de criação (RBAC nativo da plataforma)", () => {
    expect(extensao.perfilPodeCriar?.("planos", "visualizador")).toBeFalsy()
    expect(extensao.perfilPodeCriar?.("pedidos", "visualizador")).toBeFalsy()
  })

  it("token DI é um símbolo (lista registrada no crud.module)", () => {
    expect(typeof CRUD_ESCOPO_EXTENSIONS).toBe("symbol")
  })
})

describe("VitrineIaEscopo — campos de fluxo nunca graváveis (prepararCorpo)", () => {
  it("mapa cobre exatamente as 4 tabelas de fluxo do ESPEC-CRUD", () => {
    expect(Object.keys(CAMPOS_DE_FLUXO_POR_TABELA).sort()).toEqual(
      ["agentes_provisionados", "configuracoes_whatsapp", "documentos", "pedidos"].sort(),
    )
    expect(CAMPOS_DE_FLUXO_POR_TABELA.pedidos).toEqual([
      "status", "pagamento_id", "link_agente", "script_embed",
    ])
    expect(CAMPOS_DE_FLUXO_POR_TABELA.documentos).toEqual([
      "caminho_armazenamento", "texto_extraido",
    ])
    expect(CAMPOS_DE_FLUXO_POR_TABELA.agentes_provisionados).toEqual([
      "openclaw_agente_id", "status", "personalidade", "link_acesso", "script_embed", "tentativas", "ultimo_erro",
    ])
    expect(CAMPOS_DE_FLUXO_POR_TABELA.configuracoes_whatsapp).toEqual([
      "status_pareamento", "ultimo_qr_gerado_em",
    ])
  })

  for (const [tabela, campos] of Object.entries(CAMPOS_DE_FLUXO_POR_TABELA)) {
    for (const campo of campos) {
      it(`create/update em ${tabela} com "${campo}" no corpo → 400 (qualquer valor)`, () => {
        for (const operacao of ["create", "update"] as const) {
          for (const valor of ["x", 1, true, null, "criado"]) {
            const corpo: Record<string, unknown> = { outro_campo: "ok" }
            corpo[campo] = valor
            expect(() =>
              extensao.prepararCorpo(tabelas[tabela]!, corpo, ctx, operacao),
            ).toThrow(BadRequestException)
            expect(() =>
              extensao.prepararCorpo(tabelas[tabela]!, corpo, ctx, operacao),
            ).toThrow(new RegExp(`${campo}.*${tabela}|${tabela}.*${campo}`, "s"))
          }
        }
      })
    }
    it(`${tabela}: corpo sem campos de fluxo passa intacto`, () => {
      const corpo: Record<string, unknown> = { nome: "Ok", ativo: true }
      expect(() => extensao.prepararCorpo(tabelas[tabela]!, corpo, ctx, "create")).not.toThrow()
      expect(corpo).toEqual({ nome: "Ok", ativo: true })
    })
  }

  it("tabelas sem fluxo (planos, itens_faq, textos_vitrine…) nunca são vetadas", () => {
    for (const resource of ["planos", "itens_faq", "metricas_destaque", "segmentos", "textos_vitrine", "integracoes_externas"]) {
      const corpo: Record<string, unknown> = { status: "ignorado", nome: "X" }
      expect(() => extensao.prepararCorpo(tabelas[resource]!, corpo, ctx, "create")).not.toThrow()
    }
  })
})

describe("VitrineIaEscopo — credenciaisCifradas write-only (barreira de leitura)", () => {
  it("integracoes_externas: chave some da linha para QUALQUER perfil", () => {
    expect(extensao.camposSensiveisNaLeitura?.("integracoes_externas", tabelas.integracoes_externas!, ctx)).toEqual([
      "credenciaisCifradas",
    ])
  })

  it("demais tabelas: nada oculto", () => {
    for (const resource of RECURSOS.filter((r) => r !== "integracoes_externas")) {
      expect(extensao.camposSensiveisNaLeitura?.(resource, tabelas[resource]!, ctx)).toEqual([])
    }
  })
})

// ============================================================================
// CrudService — wiring com db fake (respostas e escrita real)
// ============================================================================

type Escrita = { tabela: string; valores: Record<string, unknown> }

function montarHarness(linhasPorTabela?: Partial<Record<string, Array<Record<string, unknown>>>>) {
  const escritas: Escrita[] = []
  const atualizacoes: Array<{ tabela: string; campos: Record<string, unknown> }> = []
  let seqInsert = 100
  let selectAtual = "desconhecida"

  const cadeia = (linhas: Array<Record<string, unknown>>) => {
    const thenable = {
      then: (onOk?: (v: Array<Record<string, unknown>>) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(linhas).then(onOk, onErr),
    }
    return {
      ...thenable,
      limit: () => ({
        ...thenable,
        offset: async () => linhas,
      }),
      offset: async () => linhas,
      orderBy: () => ({ limit: () => ({ offset: async () => linhas }) }),
    }
  }

  const db = {
    select: () => ({
      from: (tabela: MySqlTable) => ({
        where: () => {
          const nome = Object.keys(tabelas).find((k) => tabelas[k] === tabela) ?? "?"
          selectAtual = nome
          return cadeia(linhasPorTabela?.[nome] ?? [{ id: 1, quantidade: 1 }])
        },
      }),
    }),
    insert: (tabela: MySqlTable) => ({
      values: async (valores: Record<string, unknown>) => {
        escritas.push({ tabela: selectAtual, valores })
        const nome = Object.keys(tabelas).find((k) => tabelas[k] === tabela) ?? "?"
        escritas.at(-1)!.tabela = nome
        return [{ insertId: ++seqInsert }]
      },
    }),
    update: (tabela: MySqlTable) => ({
      set: (campos: Record<string, unknown>) => {
        const nome = Object.keys(tabelas).find((k) => tabelas[k] === tabela) ?? "?"
        atualizacoes.push({ tabela: nome, campos })
        return { where: async () => [{ affectedRows: 1 }] }
      },
    }),
    delete: () => ({ where: async () => [{ affectedRows: 1 }] }),
  }

  return { db: db as unknown as ProjetoDb, escritas, atualizacoes }
}

function serviceHarness(
  linhasPorTabela?: Partial<Record<string, Array<Record<string, unknown>>>>,
  slugNoRegistry = SLUG_VITRINE_IA,
  extensoes: unknown[] = [extensao],
) {
  const { db, escritas, atualizacoes } = montarHarness(linhasPorTabela)
  const registry: SchemaRegistry = {
    tabelasDoProjeto: (slug: string) => (slug === slugNoRegistry ? tabelas : undefined),
    projetosCarregados: () => [slugNoRegistry],
  }
  const factory = { obter: async () => db } as unknown as ProjectDbFactory
  const configService = { get: () => undefined } as unknown as ConfigService
  const service = new CrudService(
    registry,
    factory,
    configService,
    new RealtimeService(),
    extensoes as never,
  )
  return { service, escritas, atualizacoes }
}

/** Service sem DB acessível — prova que a barreira ocorre antes de conectar. */
function montarSemDb() {
  const registry: SchemaRegistry = {
    tabelasDoProjeto: (slug: string) => (slug === SLUG_VITRINE_IA ? tabelas : undefined),
    projetosCarregados: () => [SLUG_VITRINE_IA],
  }
  const factory = {
    obter: async () => {
      throw new Error("database não deveria ser acionado neste teste")
    },
  } as unknown as ProjectDbFactory
  const configService = { get: () => undefined } as unknown as ConfigService
  return new CrudService(registry, factory, configService, new RealtimeService(), [extensao])
}

function projetoVitrine(perfil: "admin" | "gerente" | "operador" | "visualizador", slug = SLUG_VITRINE_IA) {
  return { id: 8509, nome: "Vitrine IA", slug, perfil }
}

const PEDIDO_VALIDO = {
  nomeNegocio: "Barbearia Teste",
  nomeContato: "Rui Barbeiro",
  email: "rui@barbearia.example",
  telefone: "11 98888-7777",
  planoId: 1,
  ciclo: "mensal",
  consentimentoLgpd: true,
}

describe("CrudService + VitrineIaEscopo — credenciaisCifradas write-only (com db fake)", () => {
  const linhas = {
    integracoes_externas: [linhaBase("integracoes_externas")],
  }

  it("POST cria integração ACEITANDO credenciaisCifradas, e a resposta não traz a chave", async () => {
    const { service, escritas } = serviceHarness(linhas)
    const resposta = await service.criar(projetoVitrine("admin"), "integracoes_externas", {
      pedidoId: 5,
      nome: "API CRM",
      urlBase: "https://crm.example.com",
      tipoAutenticacao: "api_key",
      credenciaisCifradas: "AES:segredo-gravo",
    })
    // escrita preservou o valor (write, não descarte)
    const insert = escritas.find((e) => e.tabela === "integracoes_externas")
    expect(insert?.valores.credenciaisCifradas).toBe("AES:segredo-gravo")
    // resposta sanitizada
    expect(resposta).not.toHaveProperty("credenciaisCifradas")
  })

  it("chaves snake_case (API direta) também gravam", async () => {
    const { service, escritas } = serviceHarness(linhas)
    await service.criar(projetoVitrine("gerente"), "integracoes_externas", {
      pedido_id: 5,
      nome: "API ERP",
      url_base: "https://erp.example.com",
      tipo_autenticacao: "api_key",
      credenciais_cifradas: "AES:snake",
    })
    const insert = escritas.find((e) => e.tabela === "integracoes_externas")
    expect(insert?.valores.credenciaisCifradas).toBe("AES:snake")
  })

  it("PUT aceita alteração de credenciaisCifradas; resposta continua sem a chave", async () => {
    const { service, atualizacoes } = serviceHarness(linhas)
    const resposta = await service.atualizar(
      projetoVitrine("admin"),
      "integracoes_externas",
      1,
      { credenciaisCifradas: "AES:novo" },
    )
    expect(atualizacoes.find((a) => a.tabela === "integracoes_externas")?.campos.credenciaisCifradas).toBe(
      "AES:novo",
    )
    expect(resposta).not.toHaveProperty("credenciaisCifradas")
  })

  it("GET listar: linhas de integracoes sem credenciaisCifradas (inclusive p/ admin)", async () => {
    const { service } = serviceHarness(linhas)
    const pagina = await service.listar(projetoVitrine("admin"), "integracoes_externas", {
      page: 1,
      pageSize: 20,
      filters: {},
    })
    expect(pagina.items).toHaveLength(1)
    expect(pagina.items[0]).not.toHaveProperty("credenciaisCifradas")
    expect(pagina.items[0]).toHaveProperty("nome", "API CRM")
  })

  it("GET detalhar: sem credenciaisCifradas", async () => {
    const { service } = serviceHarness(linhas)
    const linha = await service.detalhar(projetoVitrine("admin"), "integracoes_externas", 1)
    expect(linha).not.toHaveProperty("credenciaisCifradas")
  })
})

describe("CrudService + VitrineIaEscopo — fluxo rejeitado antes de tocar o banco", () => {
  it("POST /pedidos com status → 400 claro, sem conectar", async () => {
    const service = montarSemDb()
    await expect(
      service.criar(projetoVitrine("admin"), "pedidos", { ...PEDIDO_VALIDO, status: "pago" }),
    ).rejects.toThrow(/status.*pedidos.*fluxo|campos.*status/s)
  })

  it("POST /pedidos com scriptEmbed (camel do form) → 400", async () => {
    const service = montarSemDb()
    await expect(
      service.criar(projetoVitrine("admin"), "pedidos", { ...PEDIDO_VALIDO, scriptEmbed: "<script/>" }),
    ).rejects.toThrow(BadRequestException)
  })

  it("PUT /pedidos com pagamentoId → 400 antes de qualquer gravação", async () => {
    const service = montarSemDb()
    await expect(
      service.atualizar(projetoVitrine("admin"), "pedidos", 1, { pagamentoId: "MP-123" }),
    ).rejects.toThrow(/pagamento_id/)
  })

  it("PUT /configuracoes_whatsapp com statusPareamento → 400", async () => {
    const service = montarSemDb()
    await expect(
      service.atualizar(projetoVitrine("operador"), "configuracoes_whatsapp", 1, {
        statusPareamento: "pareado",
      }),
    ).rejects.toThrow(/status_pareamento/)
  })

  it("POST /agentes_provisionados com tentativas → 400 (mesmo admin)", async () => {
    const service = montarSemDb()
    await expect(
      service.criar(projetoVitrine("admin"), "agentes_provisionados", {
        pedidoId: 5,
        nome: "Atendente Ana",
        tentativas: 3,
      }),
    ).rejects.toThrow(/tentativas/)
  })
})

describe("CrudService + VitrineIaEscopo — escrita normal sem campos de fluxo", () => {
  it("POST /pedidos válido → grava e a resposta reida vem do detalhar", async () => {
    const { service, escritas } = serviceHarness({ pedidos: [linhaBase("pedidos")] })
    const resposta = await service.criar(projetoVitrine("operador"), "pedidos", PEDIDO_VALIDO)
    expect(escritas.find((e) => e.tabela === "pedidos")).toBeTruthy()
    expect(resposta).toHaveProperty("id", 1)
    expect(resposta).not.toHaveProperty("credenciaisCifradas")
  })

  it("PUT /pedidos sem campos de fluxo → grava normalmente", async () => {
    const { service, atualizacoes } = serviceHarness({ pedidos: [linhaBase("pedidos")] })
    await service.atualizar(projetoVitrine("gerente"), "pedidos", 1, { telefone: "11 97777-6666" })
    expect(atualizacoes.find((a) => a.tabela === "pedidos")?.campos.telefone).toBe("11 97777-6666")
  })
})

describe("CrudService + VitrineIaEscopo — RBAC nativo (visualizador só lê)", () => {
  it("POST de QUALQUER resource por visualizador → 403 antes do banco (regra PERFIS_PODEM_CRIAR)", async () => {
    const service = montarSemDb()
    await expect(
      service.criar(projetoVitrine("visualizador"), "planos", {
        nome: "Plano Pro",
        precoMensal: "99.90",
      }),
    ).rejects.toThrow(ForbiddenException)
    await expect(
      service.criar(projetoVitrine("visualizador"), "pedidos", PEDIDO_VALIDO),
    ).rejects.toThrow(/Perfil insuficiente/)
  })

  it("visualizador LÊ normalmente (listar/detalhar respondem com a barreira de credenciais)", async () => {
    const { service } = serviceHarness({ integracoes_externas: [linhaBase("integracoes_externas")] })
    const pagina = await service.listar(projetoVitrine("visualizador"), "integracoes_externas", {
      page: 1,
      pageSize: 10,
      filters: {},
    })
    expect(pagina.items[0]).not.toHaveProperty("credenciaisCifradas")
    const linha = await service.detalhar(projetoVitrine("visualizador"), "integracoes_externas", 1)
    expect(linha).toHaveProperty("nome", "API CRM")
  })

  it("operador/gerente/admin podem criar (regra padrão da plataforma preservada)", async () => {
    const { service } = serviceHarness({ planos: [{ id: 1, nome: "Pro" }] })
    for (const perfil of ["admin", "gerente", "operador"] as const) {
      await expect(
        service.criar(projetoVitrine(perfil), "planos", { nome: `Plano ${perfil}`, precoMensal: "49.90" }),
      ).resolves.toHaveProperty("id", 1)
    }
  })

  it("controller: PUT e DELETE exigem admin/gerente/operador via RolesGuard; GET é livre", () => {
    const guard = new RolesGuard(new Reflector())
    const contexto = (handler: object, perfil: string) =>
      ({
        getHandler: () => handler,
        getClass: () => CrudController,
        switchToHttp: () => ({ getRequest: () => ({ scope: { projeto: { perfil } } }) }),
      }) as unknown as ExecutionContext

    // Metadados nativos dos métodos (sem alteração na plataforma).
    expect(Reflect.getMetadata(ROLES_KEY, CrudController.prototype.atualizar)).toEqual([
      "admin", "gerente", "operador",
    ])
    expect(Reflect.getMetadata(ROLES_KEY, CrudController.prototype.remover)).toEqual([
      "admin", "gerente", "operador",
    ])
    expect(Reflect.getMetadata(ROLES_KEY, CrudController.prototype.listar)).toBeUndefined()
    expect(Reflect.getMetadata(ROLES_KEY, CrudController.prototype.detalhar)).toBeUndefined()

    // Comportamento do guard sobre esses metadados.
    expect(() =>
      guard.canActivate(contexto(CrudController.prototype.atualizar, "visualizador")),
    ).toThrow(ForbiddenException)
    expect(() =>
      guard.canActivate(contexto(CrudController.prototype.remover, "visualizador")),
    ).toThrow(ForbiddenException)
    expect(guard.canActivate(contexto(CrudController.prototype.atualizar, "operador"))).toBe(true)
    expect(guard.canActivate(contexto(CrudController.prototype.remover, "gerente"))).toBe(true)
    expect(guard.canActivate(contexto(CrudController.prototype.listar, "visualizador"))).toBe(true)
  })
})

describe("CrudService + VitrineIaEscopo — extensão keyed por slug (outros projetos intactos)", () => {
  it("mesma tabela sob outro slug: credenciais continuam na resposta e fluxo é aceito", async () => {
    const outroSlug = "outro-projeto-qualquer"
    const { service } = serviceHarness(
      { integracoes_externas: [linhaBase("integracoes_externas")] },
      outroSlug,
    )
    const linha = await service.detalhar(projetoVitrine("admin", outroSlug), "integracoes_externas", 1)
    expect(linha).toHaveProperty("credenciaisCifradas", "AES:NUNCA-EXPOR")

    const service2 = serviceHarness(undefined, outroSlug)
    await service2.service.criar(projetoVitrine("admin", outroSlug), "pedidos", {
      ...PEDIDO_VALIDO,
      status: "pago",
    })
    expect(service2.escritas.find((e) => e.tabela === "pedidos")?.valores.status).toBe("pago")
  })

  it("sem extensão registrada para a vitrine → comportamento padrão (regressão de wiring)", async () => {
    const { service } = serviceHarness(
      { integracoes_externas: [linhaBase("integracoes_externas")] },
      SLUG_VITRINE_IA,
      [],
    )
    const linha = await service.detalhar(projetoVitrine("admin"), "integracoes_externas", 1)
    expect(linha).toHaveProperty("credenciaisCifradas")
  })
})

describe("CrudService + VitrineIaEscopo — CRUD responde pelas 10 tabelas", () => {
  it("listar e detalhar funcionam para todos os resources do schema", async () => {
    for (const resource of RECURSOS) {
      const { service } = serviceHarness({ [resource]: [linhaBase(resource)] })
      const pagina = await service.listar(projetoVitrine("admin"), resource, {
        page: 1,
        pageSize: 10,
        filters: {},
      })
      expect(pagina.items.length).toBeGreaterThan(0)
      const linha = await service.detalhar(projetoVitrine("admin"), resource, 1)
      expect(linha).toHaveProperty("id", 1)
      if (resource === "integracoes_externas") {
        expect(linha).not.toHaveProperty("credenciaisCifradas")
      }
    }
  })

  it("resource inexistente → 404", async () => {
    const { service } = serviceHarness()
    await expect(
      service.listar(projetoVitrine("admin"), "tableas_fantasma", { page: 1, pageSize: 10, filters: {} }),
    ).rejects.toThrow(/n/i)
  })
})
