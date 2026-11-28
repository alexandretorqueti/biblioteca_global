// @vitest-environment node
/**
 * Unit tests do endpoint público da vitrine (macro #10, posição 2/11 —
 * subtarefa 1), no padrão de db fake de `vitrine-ia-escopo.spec.ts`.
 *
 * O fake interpreta as condições reais de query que o service constrói
 * (eq/asc sobre as colunas do schema drizzle): assim os testes provam, sem
 * MySQL, que (a) somente linhas `ativo = true` passam pelo WHERE, (b) a
 * ordenação é `ordem` com `id` como desempate, e (c) a serialização é por
 * allow-list — as linhas fake carregam TODAS as colunas internas (id, ativo,
 * ordem, credenciais_cifradas, pedido_id, status…) e nada disso pode chegar
 * ao payload.
 *
 * Cobre também a resolução server-side (slug fixo → core → factory.obter),
 * a ausência de guard de auth na rota e a não-colisão com o CRUD dinâmico
 * `/api/:slug/:resource` e com `/api/vendas/planos`.
 */
import { describe, expect, it } from "vitest"
import { NotFoundException } from "@nestjs/common"
import { Column, Param, getTableName, type SQL } from "drizzle-orm"
import {
  vitrinePublicaConteudoSchema,
  type VitrinePublicaConteudo,
} from "@biblioteca-global/shared"
import { projetos } from "../../../../../../database/schema"
import {
  itensFaq,
  metricasDestaque,
  planos,
  segmentos,
  textosVitrine,
} from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { AppModule } from "../../../app.module"
import { CrudModule } from "../../crud/crud.module"
import { SLUG_VITRINE_IA } from "../../crud/escopo/vitrine-ia.escopo"
import { VendasController } from "../../vendas/vendas.controller"
import type { ProjectDbFactory, ProjetoDb } from "../../crud/project-db.factory"
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator"
import { VitrinePublicaController } from "../vitrine-publica.controller"
import { VitrinePublicaModule } from "../vitrine-publica.module"
import {
  normalizarFaq,
  normalizarMetrica,
  normalizarPlano,
  normalizarSegmento,
  normalizarTexto,
  VitrinePublicaService,
} from "../vitrine-publica.service"

type Registro = Record<string, unknown>

// ============================================================================
// Interpretação das queries drizzle construídas pelo service
// ============================================================================

interface Chunk {
  tipo: "coluna" | "igual" | "param" | "direcao" | "outro"
  nome?: string
  valor?: unknown
  direcao?: "asc" | "desc"
}

/** Achata `queryChunks` de um SQL da drizzle (eq/asc/and) em tokens lineares. */
function achatar(node: unknown): Chunk[] {
  if (node == null) return []
  const bruto = node as { queryChunks?: unknown; value?: unknown } & SQL
  if (Array.isArray(bruto.queryChunks)) return bruto.queryChunks.flatMap(achatar)
  if (node instanceof Column) return [{ tipo: "coluna", nome: node.name }]
  if (node instanceof Param) return [{ tipo: "param", valor: bruto.value }]
  // StringChunk guarda o texto em `value: string[]` (ex.: [" = "]).
  if (Array.isArray(bruto.value)) {
    const texto = bruto.value.filter((p): p is string => typeof p === "string").join("").trim()
    if (texto === "=") return [{ tipo: "igual" }]
    if (texto === "asc" || texto === "desc") return [{ tipo: "direcao", direcao: texto }]
  }
  return [{ tipo: "outro" }]
}

/** eq(col, valor) → { coluna, valor }; espera-se exatamente o formato do spike. */
function extrairIgualdades(cond: unknown): Array<{ coluna: string; valor: unknown }> {
  const chunks = achatar(cond)
  const pares: Array<{ coluna: string; valor: unknown }> = []
  for (let i = 0; i + 2 < chunks.length; i++) {
    const a = chunks[i]
    const b = chunks[i + 1]
    const c = chunks[i + 2]
    if (a?.tipo === "coluna" && b?.tipo === "igual" && c?.tipo === "param") {
      pares.push({ coluna: a.nome!, valor: c.valor })
    }
  }
  if (pares.length === 0) throw new Error("WHERE não interpretável no fake — service mudou a forma da query")
  return pares
}

function extrairOrdenacao(cond: unknown): Array<{ coluna: string; direcao: "asc" | "desc" }> {
  const chunks = achatar(cond)
  const chaves: Array<{ coluna: string; direcao: "asc" | "desc" }> = []
  for (let i = 0; i + 1 < chunks.length; i++) {
    const a = chunks[i]
    const b = chunks[i + 1]
    if (a?.tipo === "coluna" && b?.tipo === "direcao") {
      chaves.push({ coluna: a.nome!, direcao: b.direcao! })
    }
  }
  if (chaves.length === 0) throw new Error("ORDER BY não interpretável no fake")
  return chaves
}

const ehVerdadeiro = (v: unknown): boolean => v === true || v === 1

function aplicarWhere(linhas: Registro[], cond: unknown): Registro[] {
  const pares = extrairIgualdades(cond)
  return linhas.filter((linha) =>
    pares.every(({ coluna, valor }) =>
      typeof valor === "boolean" ? ehVerdadeiro(linha[coluna]) === valor : linha[coluna] === valor,
    ),
  )
}

/** ASC do MySQL: NULL primeiro; desempates mantêm a ordem de chegada (estável). */
function aplicarOrderBy(linhas: Registro[], conds: unknown[]): Registro[] {
  const chaves = conds.flatMap(extrairOrdenacao)
  return [...linhas].sort((a, b) => {
    for (const { coluna, direcao } of chaves) {
      const va = a[coluna]
      const vb = b[coluna]
      if (va === vb) continue
      if (va === null || va === undefined) return -1
      if (vb === null || vb === undefined) return 1
      const cmp = (va as number | string) < (vb as number | string) ? -1 : 1
      return direcao === "desc" ? -cmp : cmp
    }
    return 0
  })
}

// ============================================================================
// Harness — db fake + factory fake
// ============================================================================

interface Fixtures {
  planos?: Registro[]
  itens_faq?: Registro[]
  metricas_destaque?: Registro[]
  segmentos?: Registro[]
  textos_vitrine?: Registro[]
}

/** Conteúdo com TODAS as colunas do schema real (incl. internas) + inativos. */
const FIXTURE_PADRAO: Required<Fixtures> = {
  planos: [
    {
      id: 2, nome: "Pro", tagline: "Site + WhatsApp, sem limites", preco_mensal: "597.00",
      preco_setup: "2500.00", beneficios: ["Conversas ilimitadas", "IA treinada com seu conteúdo"],
      texto_botao: "Quero o Pro", mais_popular: 1, ordem: 2, ativo: 1,
    },
    {
      id: 1, nome: "Starter", tagline: "Para quem está começando a automatizar", preco_mensal: "297.00",
      preco_setup: "1500.00", beneficios: ["Atendente virtual no site"],
      texto_botao: "Começar agora", mais_popular: 0, ordem: 1, ativo: 1,
    },
    {
      // plano INATIVO: não pode aparecer na resposta pública
      id: 3, nome: "Enterprise", tagline: "Sob medida", preco_mensal: "1200.00",
      preco_setup: null, beneficios: null, texto_botao: null,
      mais_popular: 0, ordem: 3, ativo: 0,
    },
  ],
  itens_faq: [
    { id: 2, pergunta: "Quanto tempo leva?", resposta: "5 dias úteis.", ordem: 2, ativo: 1 },
    { id: 1, pergunta: "Preciso trocar meu número?", resposta: "Não.", ordem: 1, ativo: 1 },
    { id: 3, pergunta: "Item desativado?", resposta: "Não aparece.", ordem: 3, ativo: 0 },
  ],
  metricas_destaque: [
    { id: 1, valor: "24/7", rotulo: "Atendimento contínuo", ordem: 1, ativo: 1 },
    { id: 2, valor: "< 3s", rotulo: "Tempo de resposta", ordem: 2, ativo: 1 },
    { id: 3, valor: "99%", rotulo: null, ordem: null, ativo: 1 },
    { id: 4, valor: "X", rotulo: "inativa", ordem: 0, ativo: 0 },
  ],
  segmentos: [
    { id: 1, titulo: "Clínicas e consultórios", descricao: "Agendamento e lembretes", icone: null, ordem: 1, ativo: 1 },
    { id: 2, titulo: "Imobiliárias", descricao: null, icone: "Home", ordem: 2, ativo: 1 },
    { id: 3, titulo: "Oculto", descricao: null, icone: null, ordem: 3, ativo: 0 },
  ],
  textos_vitrine: [
    { id: 1, chave: "hero_titulo", conteudo: "Seu atendimento 24 horas", secao: "hero", ativo: 1 },
    { id: 18, chave: "whatsapp_link", conteudo: "https://wa.me/5521988161553", secao: "contato", ativo: 1 },
    { id: 9, chave: "sem_secao", conteudo: "texto solto", secao: null, ativo: 1 },
    { id: 20, chave: "cta_titulo", conteudo: "desativado", secao: "cta", ativo: 0 },
  ],
}

/** Colunas internas que NUNCA podem aparecer no payload público. */
const CAMPOS_VETADOS = [
  "id", "ativo", "ordem",
  // pedidos / documentos / integrações / agentes / whatsapp
  "nome_negocio", "nome_contato", "email", "telefone", "plano_id", "ciclo",
  "informacoes_negocio", "status", "pagamento_id", "link_agente", "script_embed",
  "consentimento_lgpd", "criado_em", "em_atualizacao", "pedido_id", "pedidoId",
  "nome_original", "mime_type", "tamanho_bytes", "caminho_armazenamento",
  "tipo_conteudo", "texto_extraido", "openclaw_agente_id", "personalidade",
  "link_acesso", "tentativas", "ultimo_erro", "url_base", "tipo_autenticacao",
  "credenciais_cifradas", "credenciaisCifradas", "headers",
  "limite_requisicoes_minuto", "somente_leitura", "agente_id",
  "status_pareamento", "alcance", "numeros_permitidos", "ultimo_qr_gerado_em",
] as const

function montarDbFake(fixture: Required<Fixtures>, contagem: { selects: number }) {
  const porTabela: Record<string, Registro[]> = {
    [getTableName(planos)]: fixture.planos,
    [getTableName(itensFaq)]: fixture.itens_faq,
    [getTableName(metricasDestaque)]: fixture.metricas_destaque,
    [getTableName(segmentos)]: fixture.segmentos,
    [getTableName(textosVitrine)]: fixture.textos_vitrine,
  }
  const db = {
    select: () => ({
      from: (tabela: unknown) => {
        const nome = getTableName(tabela as never)
        const linhas = porTabela[nome]
        if (!linhas) throw new Error(`fake não conhece a tabela ${nome}`)
        contagem.selects += 1
        return {
          where: (cond: unknown) => ({
            orderBy: (...conds: unknown[]) => Promise.resolve(aplicarOrderBy(aplicarWhere(linhas, cond), conds)),
          }),
        }
      },
    }),
  }
  return db as unknown as ProjetoDb
}

function montarCoreDbFake(linhasProjetos: Registro[], contagem: { selectsCore: number }) {
  const db = {
    select: () => ({
      from: (tabela: unknown) => {
        const nome = getTableName(tabela as never)
        contagem.selectsCore += 1
        if (nome !== getTableName(projetos)) throw new Error(`core fake só serve projetos (recebeu ${nome})`)
        return {
          where: () => ({
            limit: () => Promise.resolve(linhasProjetos),
          }),
        }
      },
    }),
  }
  return db as never
}

function montarHarness(opcoes?: {
  fixtures?: Partial<Fixtures>
  linhasProjetosCore?: Registro[]
  factoryObter?: ProjectDbFactory["obter"]
}) {
  const fixture = { ...FIXTURE_PADRAO, ...opcoes?.fixtures }
  const contagem = { selects: 0, selectsCore: 0 }
  const idsPedidosNaFactory: Array<{ id: number }> = []
  const db = montarDbFake(fixture, contagem)
  const factory = {
    obter: async (projeto: { id: number }) => {
      idsPedidosNaFactory.push(projeto)
      return opcoes?.factoryObter ? opcoes.factoryObter(projeto) : db
    },
  } as unknown as ProjectDbFactory
  const coreDb = montarCoreDbFake(
    opcoes?.linhasProjetosCore ?? [{ id: 8509 }],
    contagem,
  )
  const service = new VitrinePublicaService(coreDb, factory)
  return { service, contagem, idsPedidosNaFactory }
}

/** Walk profundo: nenhuma chave vetada em nenhum nível do payload. */
function chavesOcultas(node: unknown, encontrados: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((item) => chavesOcultas(item, encontrados))
  else if (node && typeof node === "object") {
    for (const [chave, valor] of Object.entries(node)) {
      if ((CAMPOS_VETADOS as readonly string[]).includes(chave)) encontrados.push(chave)
      chavesOcultas(valor, encontrados)
    }
  }
  return encontrados
}

// ============================================================================
// Contrato: resposta parseia e é somente conteúdo ativo
// ============================================================================

describe("VitrinePublicaService — resposta pública (db fake)", () => {
  it("parseia integralmente no zod schema do contrato compartilhado", async () => {
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    expect(() => vitrinePublicaConteudoSchema.parse(resposta)).not.toThrow()
  })

  it("somente linhas ativo = true retornam, por tabela", async () => {
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    expect(resposta.planos.map((p) => p.nome)).toEqual(["Starter", "Pro"])
    expect(resposta.faq.map((f) => f.pergunta)).toEqual([
      "Preciso trocar meu número?", "Quanto tempo leva?",
    ])
    // `ordem` NULL vem primeiro no ASC do MySQL (caso de borda proposital na métrica 3)
    expect(resposta.metricas.map((m) => m.valor)).toEqual(["99%", "24/7", "< 3s"])
    expect(resposta.segmentos.map((s) => s.titulo)).toEqual(["Clínicas e consultórios", "Imobiliárias"])
    expect(resposta.textos.map((t) => t.chave).sort()).toEqual(["hero_titulo", "sem_secao", "whatsapp_link"])
  })

  it("ordena por ordem com id como desempate; textos sem ordem → por id", async () => {
    const { service } = montarHarness({
      fixtures: {
        planos: [
          { id: 10, nome: "B", tagline: null, preco_mensal: "1.00", preco_setup: null, beneficios: [], texto_botao: null, mais_popular: 0, ordem: 1, ativo: 1 },
          { id: 5, nome: "A", tagline: null, preco_mensal: "2.00", preco_setup: null, beneficios: [], texto_botao: null, mais_popular: 0, ordem: 1, ativo: 1 },
          { id: 7, nome: "C", tagline: null, preco_mensal: "3.00", preco_setup: null, beneficios: [], texto_botao: null, mais_popular: 0, ordem: 2, ativo: 1 },
        ],
      },
    })
    const resposta = await service.obterConteudo()
    expect(resposta.planos.map((p) => p.nome)).toEqual(["A", "B", "C"])
  })

  it("textos carregam whatsapp_link (chave centralizada do WhatsApp)", async () => {
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    expect(resposta.textos.some((t) => t.chave === "whatsapp_link")).toBe(true)
  })
})

describe("VitrinePublicaService — allow-list: nenhum campo interno serializável", () => {
  it("nenhuma chave vetada (id/ativo/ordem/pedidos/credenciais/fluxo) no payload", async () => {
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    expect(chavesOcultas(resposta)).toEqual([])
  })

  it("keys de cada item batem exatamente com a allow-list do contrato", async () => {
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    const chavesDe = (item: object) => Object.keys(item).sort().join(",")
    for (const p of resposta.planos) {
      expect(chavesDe(p)).toBe(["beneficios", "maisPopular", "nome", "precoMensal", "precoSetup", "tagline", "textoBotao"].sort().join(","))
    }
    for (const f of resposta.faq) expect(chavesDe(f)).toBe(["pergunta", "resposta"].sort().join(","))
    for (const m of resposta.metricas) expect(chavesDe(m)).toBe(["valor", "rotulo"].sort().join(","))
    for (const s of resposta.segmentos) expect(chavesDe(s)).toBe(["descricao", "icone", "titulo"].sort().join(","))
    for (const t of resposta.textos) expect(chavesDe(t)).toBe(["chave", "conteudo", "secao"].sort().join(","))
  })

  it("linhas de tabela interna (pedidos/integracoes) não têm SELECT disparado pelo service", async () => {
    // O fake falha se qualquer tabela fora das 5 de conteúdo for consultada.
    const { service } = montarHarness()
    await expect(service.obterConteudo()).resolves.toBeTruthy()
  })
})

// ============================================================================
// Normalizadores — coerção de tipos vindos do MySQL
// ============================================================================

describe("normalizadores — allow-list e coerção", () => {
  it("plano: decimal string → number; json string → lista; 0/1 → boolean; extras descartados", () => {
    expect(normalizarPlano({
      id: 9, nome: "Pro", tagline: "X", preco_mensal: "597.00", preco_setup: null,
      beneficios: '["a","b",3]', texto_botao: "Ir", mais_popular: 1, ordem: 2, ativo: 1,
      credenciais_cifradas: "VAZARIA", email: "vazar@x.com",
    })).toEqual({
      nome: "Pro", tagline: "X", precoMensal: 597, precoSetup: null,
      beneficios: ["a", "b"], textoBotao: "Ir", maisPopular: true,
    })
  })

  it("plano: beneficios já parseado (mysql2) passa; não-string é filtrado", () => {
    expect(normalizarPlano({ nome: "P", preco_mensal: 10, beneficios: ["ok", { url: "x" }, 42] }).beneficios)
      .toEqual(["ok"])
    expect(normalizarPlano({ nome: "P", preco_mensal: 10, beneficios: null }).beneficios).toEqual([])
  })

  it("faq/metrica/segmento/texto: somente campos de exibição", () => {
    expect(normalizarFaq({ id: 1, pergunta: "P", resposta: "R", ordem: 2, ativo: 1, pedido_id: 7 }))
      .toEqual({ pergunta: "P", resposta: "R" })
    expect(normalizarMetrica({ id: 2, valor: "24/7", rotulo: null, status: "fluxo" }))
      .toEqual({ valor: "24/7", rotulo: null })
    expect(normalizarSegmento({ id: 3, titulo: "T", descricao: "D", icone: null, tentativas: 4 }))
      .toEqual({ titulo: "T", descricao: "D", icone: null })
    expect(normalizarTexto({ id: 4, chave: "hero_titulo", conteudo: "C", secao: "hero", ultimo_erro: "e" }))
      .toEqual({ chave: "hero_titulo", secao: "hero", conteudo: "C" })
  })

  it("texto com secao fora do enum vira null (não vaza valor inesperado no contrato)", () => {
    expect(normalizarTexto({ chave: "k", secao: "campanhas", conteudo: "c" }).secao).toBeNull()
  })
})

// ============================================================================
// Resolução server-side do banco (slug fixo → core → factory)
// ============================================================================

describe("VitrinePublicaService — resolução do banco nunca vem do payload", () => {
  it("usa o id do projeto resolvido no core (8509) via ProjectDbFactory", async () => {
    const { service, idsPedidosNaFactory } = montarHarness()
    await service.obterConteudo()
    expect(idsPedidosNaFactory).toEqual([{ id: 8509 }])
  })

  it("cacheia o projeto no core: segunda chamada não reconsulta o core", async () => {
    const { service, contagem } = montarHarness()
    await service.obterConteudo()
    const aposPrimeira = contagem.selectsCore
    await service.obterConteudo()
    expect(contagem.selectsCore).toBe(aposPrimeira)
    expect(aposPrimeira).toBe(1)
  })

  it("slug inexistente no core → NotFoundException (sem consultar tabela alguma)", async () => {
    const { service, contagem } = montarHarness({ linhasProjetosCore: [] })
    await expect(service.obterConteudo()).rejects.toThrow(NotFoundException)
    expect(contagem.selects).toBe(0)
  })

  it("query de conteúdo tem exatamente WHERE ativo e ORDER por coluna do schema", async () => {
    // Prova indireta: o fake exige WHERE/ORDER interpretáveis e lança se o
    // service abandonar o filtro de ativo — um teste de regressão de forma.
    const { service } = montarHarness()
    const resposta = await service.obterConteudo()
    expect(resposta.planos.every((p) => p.nome !== "Enterprise")).toBe(true)
  })
})

// ============================================================================
// Rota pública: sem auth e sem colisão
// ============================================================================

describe("VitrinePublicaController — rota pública sem colisão", () => {
  it("GET /vitrine/conteudo responde sem token (handler é @Public e classe não tem guard)", () => {
    expect(Reflect.getMetadata("path", VitrinePublicaController)).toBe("vitrine")
    expect(Reflect.getMetadata("path", VitrinePublicaController.prototype.conteudo)).toBe("conteudo")
    expect(Reflect.getMetadata("method", VitrinePublicaController.prototype.conteudo)).toBe(0) // RequestMethod.GET
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, VitrinePublicaController.prototype.conteudo)).toBe(true)
    expect(Reflect.getMetadata("__guards__", VitrinePublicaController) ?? []).toHaveLength(0)
  })

  it("registrado ANTES do CrudModule no AppModule → estática vence :slug/:resource", () => {
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[]
    const idxVitrine = imports.indexOf(VitrinePublicaModule)
    const idxCrud = imports.indexOf(CrudModule)
    expect(idxVitrine).toBeGreaterThanOrEqual(0)
    expect(idxCrud).toBeGreaterThanOrEqual(0)
    expect(idxVitrine).toBeLessThan(idxCrud)
  })

  it("rota legada /api/vendas/planos vive em prefixo próprio (sem choque com vitrine)", () => {
    expect(Reflect.getMetadata("path", VendasController)).toBe("vendas")
    expect(Reflect.getMetadata("path", VendasController.prototype.listarPlanos)).toBe("planos")
    expect(Reflect.getMetadata("path", VitrinePublicaController)).not.toBe(
      Reflect.getMetadata("path", VendasController),
    )
  })

  it("'vitrine' não é slug de projeto → o CRUD dinâmico jamais serviria /vitrine/conteudo", () => {
    expect("vitrine").not.toBe(SLUG_VITRINE_IA)
  })
})

// ============================================================================
// Wiring do módulo
// ============================================================================

describe("VitrinePublicaModule — composição mínima", () => {
  it("declara controller e service sem importar módulos de auth", () => {
    const controllers = Reflect.getMetadata("controllers", VitrinePublicaModule) as unknown[]
    const providers = Reflect.getMetadata("providers", VitrinePublicaModule) as unknown[]
    const imports = (Reflect.getMetadata("imports", VitrinePublicaModule) ?? []) as unknown[]
    expect(controllers).toContain(VitrinePublicaController)
    expect(providers).toContain(VitrinePublicaService)
    // AuthModule não é importado: a rota é pública por construção.
    expect(imports).toHaveLength(0)
  })

  it("resposta agregada tem exatamente as 5 coleções do contrato", async () => {
    const { service } = montarHarness()
    const resposta = (await service.obterConteudo()) as VitrinePublicaConteudo
    expect(Object.keys(resposta).sort()).toEqual(["faq", "planos", "segmentos", "textos", "metricas"].sort())
  })
})
