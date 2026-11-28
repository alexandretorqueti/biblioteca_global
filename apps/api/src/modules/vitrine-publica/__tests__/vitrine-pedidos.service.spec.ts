// @vitest-environment node
/**
 * Testes unitários do VitrinePedidosService (vitrine-ia — macro #10,
 * posição 3/11 — subtarefa 1): criação pública do pedido com upload e
 * acompanhamento por token (REQ-F-004/REQ-F-015).
 *
 * Estratégia: db fake encadeável que INTERPRETA as condições reais de query
 * que o service constrói (padrão `vitrine-publica.service.spec.ts` —
 * eq/asc sobre colunas do schema drizzle) + I/O REAL em diretório
 * temporário para o armazenamento em disco. Os inserts são staged na
 * transação fake: um throw no meio NÃO deixa linha alguma no banco —
 * provando o rollback exigido pelos critérios.
 *
 * Cobre:
 * - criação ok: pedido `status='criado'` com token hex-64 unique, documento
 *   por arquivo (nomeOriginal, mimeType, tamanhoBytes, caminhoArmazenamento
 *   = CHAVE LÓGICA `pedido/{uuid}/{uuid}.{ext}`, tipoConteudo) e
 *   `textoLivre` → documento `texto_livre` com o texto gravado;
 * - validação server-side: dados ausentes/JSON inválido/chaves de fluxo
 *   (status, pagamentoId, linkAgente, scriptEmbed, id, planoId) → 400 SEM
 *   efeito (nada persistido, nada em disco);
 * - whitelist de extensão×MIME: .exe → 400; MIME divergente do declarado
 *   para pdf/docx → 400; txt com texto_* ok;
 * - limite de bytes do env: arquivo acima de VITRINE_UPLOAD_MAX_BYTES →
 *   400 citando o máximo (e o limite lido do env na constante do multer);
 * - plano resolvido por nome SOMENTE ativo (inexistente/inativo → 400);
 * - falha de persistência → arquivos gravados são removidos (sem órfãos);
 * - acompanhamento: somente o pedido do token (allow-list), token errado
 *   (formato válido, inexistente) → 404, fora do formato → 404 sem
 *   consultar o banco; token A NUNCA retorna o pedido B;
 * - nenhuma resposta expõe campos internos (id, caminhoArmazenamento,
 *   textoExtraido, pagamentoId, linkAgente, scriptEmbed, planoId);
 * - controller: rotas @Public sem guard, sem listagem GET /vitrine/pedidos;
 * - módulo: pedidos registrados antes do CrudModule (rota estática vence).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BadRequestException, NotFoundException, PayloadTooLargeException } from "@nestjs/common"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Column, Param, getTableName, type SQL } from "drizzle-orm"
import {
  vitrinePedidoAcompanhamentoSchema,
  vitrinePedidoCriacaoRespostaSchema,
} from "@biblioteca-global/shared"
import {
  documentos,
  pedidos,
  planos,
} from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { AppModule } from "../../../app.module"
import { CrudModule } from "../../crud/crud.module"
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator"
import type { EnvService } from "../../../config/env.service"
import { VitrinePublicaModule } from "../vitrine-publica.module"
import { VitrinePublicaController } from "../vitrine-publica.controller"
import { VitrinePublicaService } from "../vitrine-publica.service"
import {
  VitrinePedidosService,
  type ArquivoVitrineMultipart,
} from "../vitrine-pedidos.service"
import {
  VITRINE_UPLOAD_MAX_BYTES_PADRAO,
  limiteUploadVitrineBytes,
} from "../vitrine-pedidos.constantes"
import { ErroUploadVitrineFilter } from "../erro-upload-vitrine.filter"

type Registro = Record<string, unknown>

// ============================================================================
// Interpretação de WHERE/ORDER BY (mesma técnica do spec do conteúdo)
// ============================================================================

interface Chunk {
  tipo: "coluna" | "igual" | "param" | "direcao" | "outro"
  nome?: string
  valor?: unknown
  direcao?: "asc" | "desc"
}

function achatar(node: unknown): Chunk[] {
  if (node == null) return []
  const bruto = node as { queryChunks?: unknown; value?: unknown } & SQL
  if (Array.isArray(bruto.queryChunks)) return bruto.queryChunks.flatMap(achatar)
  if (node instanceof Column) return [{ tipo: "coluna", nome: node.name }]
  if (node instanceof Param) return [{ tipo: "param", valor: bruto.value }]
  if (Array.isArray(bruto.value)) {
    const texto = bruto.value.filter((p): p is string => typeof p === "string").join("").trim()
    if (texto === "=") return [{ tipo: "igual" }]
    if (texto === "asc" || texto === "desc") return [{ tipo: "direcao", direcao: texto }]
  }
  return [{ tipo: "outro" }]
}

function extrairIgualdades(cond: unknown): Array<{ coluna: string; valor: unknown }> {
  const chunks = achatar(cond)
  const pares: Array<{ coluna: string; valor: unknown }> = []
  for (let i = 0; i + 2 < chunks.length; i++) {
    const a = chunks[i]!
    const b = chunks[i + 1]!
    const c = chunks[i + 2]!
    if (a.tipo === "coluna" && b.tipo === "igual" && c.tipo === "param") {
      pares.push({ coluna: a.nome!, valor: c.valor })
    }
  }
  return pares
}

function extrairOrdenacao(conds: unknown[]): Array<{ coluna: string; direcao: "asc" | "desc" }> {
  const chaves: Array<{ coluna: string; direcao: "asc" | "desc" }> = []
  for (const cond of conds) {
    const chunks = achatar(cond)
    for (let i = 0; i + 1 < chunks.length; i++) {
      const a = chunks[i]!
      const b = chunks[i + 1]!
      if (a.tipo === "coluna" && b.tipo === "direcao") {
        chaves.push({ coluna: a.nome!, direcao: b.direcao! })
      }
    }
  }
  return chaves
}

const ehVerdadeiro = (v: unknown): boolean => v === true || v === 1

function aplicarWhere(linhas: Registro[], cond: unknown): Registro[] {
  const pares = extrairIgualdades(cond)
  if (pares.length === 0) throw new Error("WHERE não interpretável no fake")
  return linhas.filter((linha) =>
    pares.every(({ coluna, valor }) =>
      typeof valor === "boolean"
        ? ehVerdadeiro(linha[coluna]) === valor
        : Number(linha[coluna]) === Number(valor) || linha[coluna] === valor,
    ),
  )
}

function aplicarOrderBy(linhas: Registro[], conds: unknown[]): Registro[] {
  const chaves = extrairOrdenacao(conds)
  if (chaves.length === 0) throw new Error("ORDER BY não interpretável no fake")
  return [...linhas].sort((a, b) => {
    for (const { coluna, direcao } of chaves) {
      const va = a[coluna]
      const vb = b[coluna]
      if (va === vb) continue
      const cmp = (va as number) < (vb as number) ? -1 : 1
      return direcao === "desc" ? -cmp : cmp
    }
    return 0
  })
}

/** Nome da tabela de uma coluna do projection (`coluna.table`). */
function tabelaDaColuna(coluna: unknown): string {
  const tabela = (coluna as { table?: unknown }).table
  return tabela ? getTableName(tabela as never) : "?"
}

// ============================================================================
// Harness — db fake com transação staged + disco temporário real
// ============================================================================

interface Fixture {
  planos: Registro[]
  pedidos: Registro[]
  documentos: Registro[]
}

interface DbFakeApi {
  db: unknown
  fixture: Fixture
  eventos: { transacoes: Array<{ comitou: boolean }>; selects: number }
  /** Força falha no INSERT de documentos (simula erro no banco). */
  falharInsercaoDocumentos: boolean
}

/** Mapeia nome de CAMPO do schema drizzle (camel) → coluna real (snake). */
function criarColunaPorCampo(tabela: unknown): Map<string, string> {
  const mapa = new Map<string, string>()
  for (const [campo, coluna] of Object.entries(tabela as Record<string, unknown>)) {
    const nome = (coluna as { name?: unknown } | null)?.name
    if (typeof nome === "string") mapa.set(campo, nome)
  }
  return mapa
}

const COLUNA_POR_CAMPO: Record<string, Map<string, string>> = {
  [getTableName(pedidos)]: criarColunaPorCampo(pedidos),
  [getTableName(documentos)]: criarColunaPorCampo(documentos),
  [getTableName(planos)]: criarColunaPorCampo(planos),
}

function montarDbFake(fixtureInicial?: Partial<Fixture>): DbFakeApi {
  const fixture: Fixture = {
    planos: [
      { id: 1, nome: "Starter", ativo: 1 },
      { id: 2, nome: "Pro", ativo: 1 },
      { id: 3, nome: "Enterprise", ativo: 0 },
    ],
    pedidos: [],
    documentos: [],
    ...fixtureInicial,
  }
  const eventos = { transacoes: [] as Array<{ comitou: boolean }>, selects: 0 }
  let seq = 100
  const api: DbFakeApi = {
    db: null as never,
    fixture,
    eventos,
    falharInsercaoDocumentos: false,
  }

  /** Aplica a projection do select sobre linhas (join pedidos×planos resolvido). */
  function projetar(
    proj: Record<string, unknown> | undefined,
    linhas: Registro[],
    tabelaBase: string,
  ): Registro[] {
    if (!proj) return linhas
    return linhas.map((linha) => {
      const saida: Registro = {}
      for (const [alias, coluna] of Object.entries(proj)) {
        const colunaTabela = tabelaDaColuna(coluna)
        if (colunaTabela === tabelaBase) {
          saida[alias] = linha[(coluna as Column).name] ?? null
        } else if (colunaTabela === getTableName(planos)) {
          // innerJoin planos ON planos.id = pedidos.plano_id
          const plano = fixture.planos.find((p) => Number(p.id) === Number(linha.plano_id))
          saida[alias] = plano?.[(coluna as Column).name] ?? null
        } else {
          throw new Error(`projection não interpretável no fake: ${alias}`)
        }
      }
      return saida
    })
  }

  function cadeiasDeSelect(proj?: Record<string, unknown>) {
    return {
      from: (tabela: unknown) => {
        const nome = getTableName(tabela as never)
        const linhas = fixture[nome as keyof Fixture]
        if (!linhas) throw new Error(`fake não conhece a tabela ${nome}`)
        eventos.selects += 1
        return {
          innerJoin: () => ({
            where: (cond: unknown) => ({
              limit: (n: number) =>
                Promise.resolve(projetar(proj, aplicarWhere(linhas, cond).slice(0, n), nome)),
            }),
          }),
          where: (cond: unknown) => ({
            limit: (n: number) =>
              Promise.resolve(projetar(proj, aplicarWhere(linhas, cond).slice(0, n), nome)),
            orderBy: (...conds: unknown[]) =>
              Promise.resolve(projetar(proj, aplicarOrderBy(aplicarWhere(linhas, cond), conds), nome)),
          }),
        }
      },
    }
  }

  function valoresParaLinha(nomeTabela: string, valores: Registro): Registro {
    const linha: Registro = {}
    // O service passa nomes de CAMPO do schema (camelCase); a fixture
    // espelha o banco real e guarda as COLUNAS (snake_case).
    for (const [campo, valor] of Object.entries(valores)) {
      linha[COLUNA_POR_CAMPO[nomeTabela]?.get(campo) ?? campo] = valor
    }
    return linha
  }

  function inserir(tabela: unknown, staged: Array<{ tabela: string; linha: Registro; id: number }>) {
    const nome = getTableName(tabela as never)
    return {
      values: (entrada: Registro | Registro[]) => {
        if (nome === getTableName(documentos) && api.falharInsercaoDocumentos) {
          return Promise.reject(new Error("fake: falha simulada no INSERT de documentos"))
        }
        const lista = Array.isArray(entrada) ? entrada : [entrada]
        const resultados: Array<{ insertId: number; affectedRows: number }> = []
        for (const valores of lista) {
          const id = ++seq
          const linha = valoresParaLinha(nome, valores)
          linha.id = id
          staged.push({ tabela: nome, linha, id })
          resultados.push({ insertId: id, affectedRows: 1 })
        }
        return Promise.resolve([resultados[0] ?? { insertId: 0, affectedRows: 0 }])
      },
    }
  }

  api.db = {
    select: (proj?: Record<string, unknown>) => cadeiasDeSelect(proj),
    insert: (tabela: unknown) => {
      // Insert fora de transação não é usado pelo service; falha cedo.
      throw new Error(`insert sem transação em ${getTableName(tabela as never)}`)
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Array<{ tabela: string; linha: Registro; id: number }> = []
      const tx = {
        insert: (tabela: unknown) => inserir(tabela, staged),
      }
      const resultado = await fn(tx)
      // commit: só publica se o fn inteiro passou (rollback = staged descartado)
      for (const { tabela, linha } of staged) {
        ;(fixture[tabela as keyof Fixture] as Registro[]).push(linha)
      }
      eventos.transacoes.push({ comitou: true })
      return resultado
    },
  }
  return api
}

function montarEnv(dir: string, maxBytes = 1024) {
  return {
    vitrineDocumentosDir: dir,
    vitrineUploadMaxBytes: maxBytes,
  } as unknown as EnvService
}

interface Harness {
  service: VitrinePedidosService
  api: DbFakeApi
  dir: string
  chamadasDbProjeto: { count: number }
}

async function montarHarness(opcoes?: { maxBytes?: number }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "vitrine-pedidos-"))
  const api = montarDbFake()
  const chamadasDbProjeto = { count: 0 }
  const vitrine = {
    obterDbProjeto: async () => {
      chamadasDbProjeto.count += 1
      return api.db as never
    },
  } as unknown as VitrinePublicaService
  const service = new VitrinePedidosService(vitrine, montarEnv(dir, opcoes?.maxBytes))
  return { service, api, dir, chamadasDbProjeto }
}

const DADOS_VALIDOS = {
  nomeNegocio: "Barbearia Navalha de Ouro",
  nomeContato: "João da Silva",
  email: "joao@navalhadeouro.com.br",
  telefone: "(21) 98816-1553",
  plano: "Pro",
  ciclo: "anual",
  informacoesNegocio: "3 cadeiras, atendo de terça a domingo.",
  consentimentoLgpd: true,
}

const dadosJson = (extra?: Record<string, unknown>, omitir?: string[]): string => {
  const base: Registro = { ...DADOS_VALIDOS, ...extra }
  for (const chave of omitir ?? []) delete base[chave]
  return JSON.stringify(base)
}

const arquivo = (
  nome: string,
  conteudo: string | Buffer,
  mimetype?: string,
): ArquivoVitrineMultipart => {
  const buffer = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, "utf8")
  return { originalname: nome, mimetype, size: buffer.length, buffer }
}

/** Lista recursiva de arquivos gravados no diretório raiz do armazenamento. */
async function listarArquivosGravados(dir: string): Promise<string[]> {
  const encontrados: string[] = []
  const walker = async (atual: string): Promise<void> => {
    for (const item of await readdir(atual, { withFileTypes: true })) {
      const caminho = join(atual, item.name)
      if (item.isDirectory()) await walker(caminho)
      else encontrados.push(caminho.slice(dir.length + 1))
    }
  }
  await walker(dir)
  return encontrados.sort()
}

/** Walk profundo: nenhuma chave vetada em nenhum nível do payload. */
const CAMPOS_VETADOS = new Set([
  "id", "pedidoId", "pedido_id", "planoId", "plano_id", "statusPagamento",
  "pagamentoId", "pagamento_id", "linkAgente", "link_agente", "scriptEmbed",
  "script_embed", "caminhoArmazenamento", "caminho_armazenamento",
  "textoExtraido", "texto_extraido", "consentimentoLgpd", "consentimento_lgpd",
  "emAtualizacao", "em_atualizacao",
])

function chavesVetadasNoObjeto(node: unknown, encontrados: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) chavesVetadasNoObjeto(item, encontrados)
  else if (node && typeof node === "object") {
    for (const [chave, valor] of Object.entries(node)) {
      if (CAMPOS_VETADOS.has(chave)) encontrados.push(chave)
      chavesVetadasNoObjeto(valor, encontrados)
    }
  }
  return encontrados
}

// ============================================================================
// Criação
// ============================================================================

describe("VitrinePedidosService.criar — pedido válido", () => {
  let h: Harness
  beforeEach(async () => {
    h = await montarHarness()
  })
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true })
  })

  it("grava pedido 'criado' com token hex-64 + documentos por arquivo + texto_livre, tudo numa transação", async () => {
    const resposta = await h.service.criar(
      dadosJson(),
      "Meu negócio faz cortes e barbas.",
      [
        arquivo("cardapio.pdf", "%PDF-1.4 fake", "application/pdf"),
        arquivo("manual.docx", "PK\u0003\u0004", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        arquivo("receitas.txt", "corte social: R$ 40", "text/plain"),
      ],
    )

    // Resposta no contrato strict: SOMENTE token/status/criadoEm/mensagem.
    expect(() => vitrinePedidoCriacaoRespostaSchema.parse(resposta)).not.toThrow()
    expect(Object.keys(resposta).sort()).toEqual(["criadoEm", "mensagem", "status", "tokenAcompanhamento"])
    expect(resposta.tokenAcompanhamento).toMatch(/^[0-9a-f]{64}$/)
    expect(resposta.status).toBe("criado")

    // Banco: exatamente 1 pedido com os campos server-side corretos.
    expect(h.api.fixture.pedidos).toHaveLength(1)
    const pedido = h.api.fixture.pedidos[0]!
    expect(pedido.status).toBe("criado")
    expect(pedido.token_acompanhamento).toBe(resposta.tokenAcompanhamento)
    expect(pedido.plano_id).toBe(2) // "Pro" resolvido por NOME → id (nunca do payload)
    expect(pedido.consentimento_lgpd).toBe(true)
    expect(pedido.pagamento_id ?? null).toBeNull()
    expect(pedido.link_agente ?? null).toBeNull()
    expect(pedido.script_embed ?? null).toBeNull()

    // Banco: 3 arquivos + 1 texto_livre; texto gravado; chave lógica por pedido.
    expect(h.api.fixture.documentos).toHaveLength(4)
    const porTipo = Object.fromEntries(
      h.api.fixture.documentos.map((d) => [d.tipo_conteudo as string, d]),
    )
    expect(Object.keys(porTipo).sort()).toEqual(["docx", "pdf", "texto_livre", "txt"])
    expect(porTipo.pdf.nome_original).toBe("cardapio.pdf")
    expect(porTipo.pdf.mimetype ?? porTipo.pdf.mime_type).toBe("application/pdf")
    expect(porTipo.pdf.caminho_armazenamento).toMatch(/^pedido\/[0-9a-f-]+\/[0-9a-f-]+\.pdf$/)
    expect(porTipo.texto_livre.texto_extraido).toBe("Meu negócio faz cortes e barbas.")
    expect(porTipo.texto_livre.caminho_armazenamento).toBeNull()
    expect(porTipo.texto_livre.tipo_conteudo).toBe("texto_livre")
    expect(porTipo.texto_livre.nome_original).toBeNull()
    expect(porTipo.texto_livre.tamanho_bytes).toBe(
      Buffer.byteLength("Meu negócio faz cortes e barbas.", "utf8"),
    )

    // Disco: um arquivo físico por upload, sob a chave lógica, conteúdo fiel.
    const gravados = await listarArquivosGravados(h.dir)
    expect(gravados).toHaveLength(3)
    for (const doc of h.api.fixture.documentos) {
      const chave = doc.caminho_armazenamento
      if (typeof chave === "string") {
        await expect(stat(join(h.dir, ...chave.split("/")))).resolves.toBeTruthy()
      }
    }

    // Transação única (pedido + documentos).
    expect(h.api.eventos.transacoes).toEqual([{ comitou: true }])
  })

  it("sem arquivos e sem textoLivre: pedido criado com zero documentos", async () => {
    const resposta = await h.service.criar(dadosJson(), undefined, [])
    expect(resposta.tokenAcompanhamento).toMatch(/^[0-9a-f]{64}$/)
    expect(h.api.fixture.pedidos).toHaveLength(1)
    expect(h.api.fixture.documentos).toHaveLength(0)
    expect(await listarArquivosGravados(h.dir)).toEqual([])
  })

  it("tokens nunca repetem entre pedidos (unique) e cada um resolve o próprio pedido", async () => {
    const a = await h.service.criar(dadosJson({ nomeNegocio: "Pet Shop A" }), undefined, [])
    const b = await h.service.criar(dadosJson({ nomeNegocio: "Clínica B" }), undefined, [])
    expect(a.tokenAcompanhamento).not.toBe(b.tokenAcompanhamento)
    const acompanaA = await h.service.acompanhar(a.tokenAcompanhamento)
    expect(acompanaA.nomeNegocio).toBe("Pet Shop A")
    const acompanaB = await h.service.acompanhar(b.tokenAcompanhamento)
    expect(acompanaB.nomeNegocio).toBe("Clínica B")
  })

  it("resoluções do banco vêm do service (slug fixo) e do plano ativo por nome", async () => {
    await h.service.criar(dadosJson(), undefined, [])
    expect(h.chamadasDbProjeto.count).toBe(1) // mesmo db resolvido uma vez
  })

  it("nome do arquivo é sanitizado (path traversal nunca escapa do diretório)", async () => {
    const resposta = await h.service.criar(
      dadosJson(),
      undefined,
      [arquivo("../../etc/passwd.pdf", "%PDF-1.4", "application/pdf")],
    )
    expect(resposta.tokenAcompanhamento).toMatch(/^[0-9a-f]{64}$/)
    const doc = h.api.fixture.documentos[0]!
    expect(doc.nome_original).toBe("passwd.pdf")
    const chave = String(doc.caminho_armazenamento)
    expect(chave.startsWith("pedido/")).toBe(true)
    const gravados = await listarArquivosGravados(h.dir)
    expect(gravados).toEqual([chave])
  })
})

describe("VitrinePedidosService.criar — validação server-side sem efeito", () => {
  let h: Harness
  beforeEach(async () => {
    h = await montarHarness()
  })
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true })
  })

  it("campo 'dados' ausente → 400 claro e nada persistido", async () => {
    await expect(h.service.criar(undefined, undefined, [])).rejects.toThrow(BadRequestException)
    await expect(h.service.criar(undefined, undefined, [])).rejects.toThrow(/'dados'/)
    expect(h.api.fixture.pedidos).toHaveLength(0)
    expect(h.api.eventos.transacoes).toHaveLength(0)
  })

  it("'dados' não-JSON → 400", async () => {
    await expect(h.service.criar("{isso não é json", undefined, [])).rejects.toThrow(/JSON/)
    expect(h.api.fixture.pedidos).toHaveLength(0)
  })

  it.each([
    ["status", "pago"],
    ["pagamentoId", "MP-123"],
    ["linkAgente", "https://x"],
    ["scriptEmbed", "<script>"],
    ["id", 9],
    ["planoId", 42],
  ])("payload com chave de fluxo/interna (%s) → 400 citando a chave", async (campo, valor) => {
    await expect(
      h.service.criar(dadosJson({ [campo]: valor }), undefined, []),
    ).rejects.toThrow(new RegExp(String(campo)))
    expect(h.api.fixture.pedidos).toHaveLength(0)
    expect(h.api.eventos.transacoes).toHaveLength(0)
  })

  it("email inválido / telefone sem DDD / consentimento false → 400 com mensagem do contrato", async () => {
    await expect(h.service.criar(dadosJson({ email: "x" }), undefined, [])).rejects.toThrow(/e-mail/i)
    await expect(h.service.criar(dadosJson({ telefone: "12345" }), undefined, []))
      .rejects.toThrow(/Telefone BR inválido/)
    await expect(h.service.criar(dadosJson({ consentimentoLgpd: false }), undefined, []))
      .rejects.toThrow(/consentimento LGPD é obrigatório/i)
    expect(h.api.fixture.pedidos).toHaveLength(0)
  })

  it("ciclo fora de {mensal,anual} e falta de campo obrigatório → 400", async () => {
    await expect(h.service.criar(dadosJson({ ciclo: "vitalício" }), undefined, []))
      .rejects.toThrow(BadRequestException)
    await expect(h.service.criar(dadosJson(undefined, ["nomeNegocio"]), undefined, []))
      .rejects.toThrow(/nomeNegocio/)
    expect(h.api.fixture.pedidos).toHaveLength(0)
  })

  it("plano inexistente ou inativo (nome) → 400 e nada gravado — só plano ATIVO resolve", async () => {
    await expect(h.service.criar(dadosJson({ plano: "Ouro Plus" }), undefined, []))
      .rejects.toThrow(/não está disponível/)
    await expect(h.service.criar(dadosJson({ plano: "Enterprise" }), undefined, []))
      .rejects.toThrow(/não está disponível/)
    expect(h.api.fixture.pedidos).toHaveLength(0)
    expect(await listarArquivosGravados(h.dir)).toEqual([])
  })

  it("extensão fora da whitelist (.exe) → 400 citando os tipos aceitos, sem disco/banco", async () => {
    await expect(
      h.service.criar(dadosJson(), undefined, [arquivo("virus.exe", "MZ", "application/octet-stream")]),
    ).rejects.toThrow(/Tipo de arquivo não permitido\. Aceitos: PDF/i)
    expect(await listarArquivosGravados(h.dir)).toEqual([])
    expect(h.api.fixture.pedidos).toHaveLength(0)
  })

  it("MIME divergente da extensão (dupla defesa) → 400", async () => {
    await expect(h.service.criar(dadosJson(), undefined, [arquivo("ok.pdf", "x", "text/plain")]))
      .rejects.toThrow(/não permitido/i)
    await expect(h.service.criar(dadosJson(), undefined, [arquivo("ok.docx", "x", "application/zip")]))
      .rejects.toThrow(/não permitido/i)
    await expect(h.service.criar(dadosJson(), undefined, [arquivo("ok.txt", "x", "application/pdf")]))
      .rejects.toThrow(/não permitido/i)
    expect(await listarArquivosGravados(h.dir)).toEqual([])
  })

  it("acima do limite de bytes configurado → 400 citando o máximo; nada em disco", async () => {
    const gigante = Buffer.alloc(2048, 0x41) // env fake = 1024 bytes
    await expect(
      h.service.criar(dadosJson(), undefined, [arquivo("grande.pdf", gigante, "application/pdf")]),
    ).rejects.toThrow(/excede o limite de 1024 bytes/)
    expect(await listarArquivosGravados(h.dir)).toEqual([])
    expect(h.api.fixture.pedidos).toHaveLength(0)
  })

  it("arquivo vazio → 400", async () => {
    await expect(
      h.service.criar(dadosJson(), undefined, [arquivo("vazio.pdf", "", "application/pdf")]),
    ).rejects.toThrow(/vazio/)
  })

  it("mais arquivos que o máximo por pedido → 400", async () => {
    const muitos = Array.from({ length: 11 }, (_, i) =>
      arquivo(`a${i}.txt`, "conteudo", "text/plain"),
    )
    await expect(h.service.criar(dadosJson(), undefined, muitos)).rejects.toThrow(/Máximo de 10/)
  })
})

describe("VitrinePedidosService.criar — atomicidade", () => {
  it("falha no INSERT de documentos → transação não comita e os arquivos gravados são removidos", async () => {
    const h = await montarHarness()
    try {
      h.api.falharInsercaoDocumentos = true
      await expect(
        h.service.criar(
          dadosJson(),
          undefined,
          [arquivo("a.pdf", "%PDF", "application/pdf"), arquivo("b.txt", "oi", "text/plain")],
        ),
      ).rejects.toThrow(/falha simulada no INSERT/)
      // Rollback: NENHUMA linha publicada (nem pedido, nem documentos)...
      expect(h.api.fixture.pedidos).toHaveLength(0)
      expect(h.api.fixture.documentos).toHaveLength(0)
      // ...e NENHUM arquivo órfão em disco.
      expect(await listarArquivosGravados(h.dir)).toEqual([])
      expect(h.api.eventos.transacoes).toHaveLength(0)
    } finally {
      await rm(h.dir, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// Acompanhamento
// ============================================================================

describe("VitrinePedidosService.acompanhar — somente o pedido do token", () => {
  let h: Harness
  let token: string

  beforeEach(async () => {
    h = await montarHarness()
    const resposta = await h.service.criar(
      dadosJson(),
      "texto do cliente",
      [arquivo("cardapio.pdf", "%PDF-1.4", "application/pdf")],
    )
    token = resposta.tokenAcompanhamento
  })
  afterEach(async () => {
    await rm(h.dir, { recursive: true, force: true })
  })

  it("retorna dados do negócio + nome do plano + ciclo + status + metadados de documentos", async () => {
    const corpo = await h.service.acompanhar(token)
    expect(() => vitrinePedidoAcompanhamentoSchema.parse(corpo)).not.toThrow()
    expect(corpo).toEqual({
      nomeNegocio: "Barbearia Navalha de Ouro",
      nomeContato: "João da Silva",
      email: "joao@navalhadeouro.com.br",
      telefone: "(21) 98816-1553",
      informacoesNegocio: "3 cadeiras, atendo de terça a domingo.",
      planoNome: "Pro",
      ciclo: "anual",
      status: "criado",
      criadoEm: corpo.criadoEm,
      documentos: [
        { nomeOriginal: "cardapio.pdf", tipoConteudo: "pdf", tamanhoBytes: Buffer.byteLength("%PDF-1.4", "utf8") },
        { nomeOriginal: null, tipoConteudo: "texto_livre", tamanhoBytes: Buffer.byteLength("texto do cliente", "utf8") },
      ],
    })
    expect(typeof corpo.criadoEm).toBe("string")
  })

  it("nenhum campo interno aparece no payload (allow-list profunda)", async () => {
    const corpo = await h.service.acompanhar(token)
    expect(chavesVetadasNoObjeto(corpo)).toEqual([])
    // O texto livre gravado no banco é o conteúdo do documento texto_livre,
    // mas NUNCA a chave textoExtraido/texto_extraido no payload.
    const json = JSON.stringify(corpo)
    expect(json).not.toContain("texto do cliente".slice(0, 10))
    expect(json).not.toContain("pedido/")
  })

  it("token válido por formato mas inexistente → 404", async () => {
    await expect(h.service.acompanhar("f".repeat(64))).rejects.toThrow(NotFoundException)
  })

  it("token fora do formato → 404 SEM consultar o banco (defesa)", async () => {
    const antes = h.api.eventos.selects
    await expect(h.service.acompanhar("lixo")).rejects.toThrow(NotFoundException)
    await expect(h.service.acompanhar(String("a".repeat(63)))).rejects.toThrow(NotFoundException)
    await expect(h.service.acompanhar(undefined as unknown as string)).rejects.toThrow(NotFoundException)
    expect(h.api.eventos.selects).toBe(antes)
  })

  it("token A nunca retorna o pedido B (isolamento por token)", async () => {
    const outro = await h.service.criar(dadosJson({ nomeNegocio: "Concorrente X" }), undefined, [])
    const corpoA = await h.service.acompanhar(token)
    const corpoB = await h.service.acompanhar(outro.tokenAcompanhamento)
    expect(corpoA.nomeNegocio).toBe("Barbearia Navalha de Ouro")
    expect(corpoB.nomeNegocio).toBe("Concorrente X")
    expect(JSON.stringify(corpoA)).not.toContain("Concorrente X")
    expect(JSON.stringify(corpoB)).not.toContain("Barbearia Navalha de Ouro")
  })
})

// ============================================================================
// Limite do multer lido do env + filtro de upload
// ============================================================================

describe("limite de upload e ErroUploadVitrineFilter", () => {
  const guardado = process.env.VITRINE_UPLOAD_MAX_BYTES
  afterEach(() => {
    if (guardado === undefined) delete process.env.VITRINE_UPLOAD_MAX_BYTES
    else process.env.VITRINE_UPLOAD_MAX_BYTES = guardado
  })

  it("constante do decorator lê VITRINE_UPLOAD_MAX_BYTES com default 10485760", () => {
    delete process.env.VITRINE_UPLOAD_MAX_BYTES
    expect(limiteUploadVitrineBytes()).toBe(VITRINE_UPLOAD_MAX_BYTES_PADRAO)
    process.env.VITRINE_UPLOAD_MAX_BYTES = "2048"
    expect(limiteUploadVitrineBytes()).toBe(2048)
    process.env.VITRINE_UPLOAD_MAX_BYTES = "abc"
    expect(limiteUploadVitrineBytes()).toBe(VITRINE_UPLOAD_MAX_BYTES_PADRAO)
    process.env.VITRINE_UPLOAD_MAX_BYTES = "0"
    expect(limiteUploadVitrineBytes()).toBe(VITRINE_UPLOAD_MAX_BYTES_PADRAO)
  })

  it("MulterError LIMIT_FILE_SIZE → 400 citando o máximo (nunca 500)", () => {
    process.env.VITRINE_UPLOAD_MAX_BYTES = "4096"
    const { capturar, host } = criarHostCaptura()
    const filtro = new ErroUploadVitrineFilter()
    filtro.catch(
      Object.assign(new Error("File too large"), { code: "LIMIT_FILE_SIZE" }) as never,
      host as never,
    )
    expect(capturar.status).toBe(400)
    expect(String(capturar.corpo.message)).toContain("4096 bytes")
  })

  it("PayloadTooLargeException (Nest 11 transforma LIMIT_FILE_SIZE antes do filtro) → 400 citando o máximo", () => {
    process.env.VITRINE_UPLOAD_MAX_BYTES = "4096"
    const { capturar, host } = criarHostCaptura()
    const filtro = new ErroUploadVitrineFilter()
    filtro.catch(new PayloadTooLargeException("File too large"), host as never)
    expect(capturar.status).toBe(400)
    expect(String(capturar.corpo.message)).toContain("4096 bytes")
  })
})

function criarHostCaptura() {
  const capturar: { status: number; corpo: Record<string, unknown> } = { status: 0, corpo: {} }
  const resposta = {
    status: (codigo: number) => {
      capturar.status = codigo
      return resposta
    },
    json: (payload: unknown) => {
      capturar.corpo = payload as Record<string, unknown>
      return resposta
    },
  }
  const host = { switchToHttp: () => ({ getResponse: () => resposta }) }
  return { capturar, host }
}

// ============================================================================
// Rota/módulo
// ============================================================================

describe("VitrinePublicaController — rotas públicas de pedido", () => {
  it("POST /vitrine/pedidos é @Public, multipart (interceptor) e usa o filtro de upload", () => {
    const handler = VitrinePublicaController.prototype.criarPedido
    expect(Reflect.getMetadata("path", VitrinePublicaController)).toBe("vitrine")
    expect(Reflect.getMetadata("path", handler)).toBe("pedidos")
    expect(Reflect.getMetadata("method", handler)).toBe(1) // RequestMethod.POST
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true)
    const filtros = Reflect.getMetadata("__exceptionFilters__", handler) ?? []
    expect(filtros).toContain(ErroUploadVitrineFilter)
    const interceptores = Reflect.getMetadata("__interceptors__", handler) ?? []
    expect(interceptores.length).toBeGreaterThan(0)
  })

  it("GET /vitrine/pedidos/:token é @Public", () => {
    const handler = VitrinePublicaController.prototype.acompanharPedido
    expect(Reflect.getMetadata("path", handler)).toBe("pedidos/:token")
    expect(Reflect.getMetadata("method", handler)).toBe(0) // RequestMethod.GET
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true)
  })

  it("NÃO existe rota pública que LISTE pedidos (nenhum GET no caminho 'pedidos')", () => {
    const prototipo = VitrinePublicaController.prototype as unknown as Record<string, unknown>
    const rotasGet = Object.getOwnPropertyNames(prototipo)
      .map((nome) => [nome, Reflect.getMetadata("path", prototipo[nome]), Reflect.getMetadata("method", prototipo[nome])] as const)
      .filter(([, , metodo]) => metodo === 0)
    for (const [, caminho] of rotasGet) {
      expect(caminho).not.toBe("pedidos")
    }
    expect(rotasGet.map(([, caminho]) => caminho).sort()).toEqual(["conteudo", "pedidos/:token"])
  })

  it("classe do controller não tem guard (rotas públicas por construção)", () => {
    expect(Reflect.getMetadata("__guards__", VitrinePublicaController) ?? []).toHaveLength(0)
  })

  it("VitrinePublicaModule segue ANTES do CrudModule no AppModule (rota estática vence :slug/:resource)", () => {
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[]
    expect(imports.indexOf(VitrinePublicaModule)).toBeGreaterThanOrEqual(0)
    expect(imports.indexOf(CrudModule)).toBeGreaterThanOrEqual(0)
    expect(imports.indexOf(VitrinePublicaModule)).toBeLessThan(imports.indexOf(CrudModule))
  })

  it("módulo declara o service de pedidos sem importar módulos de auth", () => {
    const providers = Reflect.getMetadata("providers", VitrinePublicaModule) as unknown[]
    const imports = (Reflect.getMetadata("imports", VitrinePublicaModule) ?? []) as unknown[]
    expect(providers).toContain(VitrinePedidosService)
    expect(imports).toHaveLength(0)
  })

  it("garante contra falha de escrita: resposta de criação não vaza caminho físico", async () => {
    const h = await montarHarness()
    try {
      // grava um arquivo real e confere que o nome do diretório temporário
      // (caminho físico) não aparece em lugar nenhum da resposta.
      await writeFile(join(h.dir, "sentinela.txt"), "x")
      const resposta = await h.service.criar(dadosJson(), undefined, [arquivo("a.pdf", "%PDF", "application/pdf")])
      expect(JSON.stringify(resposta)).not.toContain(h.dir)
      expect(chavesVetadasNoObjeto(resposta)).toEqual([])
    } finally {
      await rm(h.dir, { recursive: true, force: true })
    }
  })
})
