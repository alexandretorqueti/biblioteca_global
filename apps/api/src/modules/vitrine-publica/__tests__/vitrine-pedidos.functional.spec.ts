// @vitest-environment node
/**
 * Teste FUNCIONAL da API pública de pedidos da vitrine (vitrine-ia —
 * macro #10, posição 3/11 — subtarefa 1) contra o ambiente real
 * (Nest bootado + MySQL `projeto_8509` + disco), no padrão das suítes
 * `*.functional.spec.ts` (excluídas do `npm test`; rodadas separadamente).
 * Execução ad-hoc:
 *   set -a; source <raiz>/.env; set +a
 *   export MYSQL_HOST=host.docker.internal PSP_PROVIDER=mercadopago \
 *          PSP_ACCESS_TOKEN=*** PSP_WEBHOOK_SECRET=***
 *   export VITRINE_DOCUMENTOS_DIR=/tmp/vitrine-func-docs VITRINE_UPLOAD_MAX_BYTES=4096
 *   npx vitest run --config <config com include apontando p/ este arquivo>
 *
 * Cobre os critérios que exigem stack real:
 * - POST /api/vitrine/pedidos (multipart: dados + arquivos + textoLivre)
 *   cria pedido `status='criado'` com token unique no banco, linhas de
 *   documento com a chave lógica `pedido/{uuid}/...` e os ARQUIVOS FISICOS
 *   gravados em disco sob VITRINE_DOCUMENTOS_DIR (conteúdo fiel);
 * - o backend é a fonte única: plano resolvido por NOME (id do payload é
 *   ignorado/rejeitado), fluxo (pagamentoId/linkAgente/scriptEmbed) segue
 *   NULL, chaves de fluxo no corpo → 400 SEM nada persistido;
 * - whitelist extensão×MIME e limite de bytes (multer) → 400 claro
 *   (nunca 500) citando o máximo;
 * - textoLivre → documento `texto_livre` com o texto gravado (sem arquivo);
 * - GET /api/vitrine/pedidos/:token: somente o pedido do token — token A
 *   NUNCA vê o pedido B; token errado/malformado → 404;
 * - nenhuma resposta expõe campos internos (id, caminhoArmazenamento,
 *   textoExtraido, pagamentoId, linkAgente, scriptEmbed, planoId);
 * - NÃO existe listagem pública (GET /api/vitrine/pedidos não é 200).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Test } from "@nestjs/testing"
import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { eq, inArray } from "drizzle-orm"
import {
  vitrinePedidoAcompanhamentoSchema,
  vitrinePedidoCriacaoRespostaSchema,
  VITRINE_TOKEN_ACOMPANHAMENTO_REGEX,
} from "@biblioteca-global/shared"
import {
  documentos,
  pedidos,
  planos,
} from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { projetos } from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../../crud/project-db.factory"
import { SLUG_VITRINE_IA } from "../../crud/escopo/vitrine-ia.escopo"

const hasMysql = Boolean(process.env.MYSQL_HOST)

const DIR_DOCUMENTOS = process.env.VITRINE_DOCUMENTOS_DIR ?? "/data/vitrine-documentos"
const MAX_BYTES = Number(process.env.VITRINE_UPLOAD_MAX_BYTES ?? 10485760)

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("x".repeat(64))])
const DOCX_BYTES = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("y".repeat(64))])
const TXT_CONTEUDO = "corte social R$ 45; barba R$ 35; funcionando ha 12 anos."

/** Chaves internas que jamais podem aparecer no payload público. */
const CAMPOS_VETADOS = new Set([
  "id", "pedidoId", "pedido_id", "planoId", "plano_id",
  "statusPagamento", "pagamentoId", "pagamento_id", "linkAgente", "link_agente",
  "scriptEmbed", "script_embed", "caminhoArmazenamento", "caminho_armazenamento",
  "textoExtraido", "texto_extraido", "consentimentoLgpd", "consentimento_lgpd",
  "emAtualizacao", "em_atualizacao", "mimeType", "mime_type", "ativo",
])

function chavesVetadasNoJson(node: unknown, encontrados: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) chavesVetadasNoJson(item, encontrados)
  else if (node && typeof node === "object") {
    for (const [chave, valor] of Object.entries(node)) {
      if (CAMPOS_VETADOS.has(chave)) encontrados.push(chave)
      chavesVetadasNoJson(valor, encontrados)
    }
  }
  return encontrados
}

function dadosPedido(campos?: Record<string, unknown>, omitir?: string[]): string {
  const base: Record<string, unknown> = {
    nomeNegocio: "Barbearia Navalha de Ouro",
    nomeContato: "João da Silva",
    email: "joao@navalhadeouro.com.br",
    telefone: "(21) 98816-1553",
    plano: "Pro",
    ciclo: "anual",
    informacoesNegocio: "3 cadeiras; atendo de terça a domingo; foco em barboterapia.",
    consentimentoLgpd: true,
    ...campos,
  }
  for (const chave of omitir ?? []) delete base[chave]
  return JSON.stringify(base)
}

async function contarPedidos(db: ProjetoDb): Promise<number> {
  const rows = await db.select({ id: pedidos.id }).from(pedidos)
  return rows.length
}

describe.skipIf(!hasMysql)(
  "POST/GET /api/vitrine/pedidos — autoatendimento público (macro #10, posição 3/11)",
  () => {
    let app: INestApplication
    let pdb: ProjetoDb
    const tokensCriados: string[] = []
    let planoProId: number

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
      app = moduleRef.createNestApplication()
      configureApp(app)
      await app.init()
      const factory = app.get<ProjectDbFactory>(PROJECT_DB_FACTORY)
      const coreDb = app.get<CoreDb>(CORE_DB)
      const projeto = (
        await coreDb.select({ id: projetos.id }).from(projetos).where(eq(projetos.slug, SLUG_VITRINE_IA))
      ).at(0)
      if (!projeto) throw new Error(`projeto ${SLUG_VITRINE_IA} ausente no core — ambiente de integração necessário`)
      pdb = await factory.obter({ id: Number(projeto.id) })
      const pro = (await pdb.select({ id: planos.id }).from(planos).where(eq(planos.nome, "Pro")).limit(1)).at(0)
      if (!pro) throw new Error("plano 'Pro' ausente no projeto — seed necessário")
      planoProId = Number(pro.id)
    })

    afterAll(async () => {
      // Limpeza: remove exatamente o que esta suíte criou (documentos → pedidos).
      if (tokensCriados.length > 0) {
        const ids = (await pdb.select({ id: pedidos.id }).from(pedidos).where(inArray(pedidos.tokenAcompanhamento, tokensCriados))).map((r) => Number(r.id))
        if (ids.length > 0) {
          await pdb.delete(documentos).where(inArray(documentos.pedidoId, ids))
          await pdb.delete(pedidos).where(inArray(pedidos.id, ids))
        }
      }
      await app?.close()
    })

    // ==========================================================================
    // Criação feliz — banco + disco + resposta
    // ==========================================================================

    it("multipart válido → 201, pedido 'criado' no banco com token unique, documentos por arquivo e texto_livre, e arquivos FISICOS em disco", async () => {
      const textoLivre = "Meu negocio e barbearia classica com agendamento por whatsapp."
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .field("dados", dadosPedido())
        .field("textoLivre", textoLivre)
        .attach("arquivos", PDF_BYTES, { filename: "cardapio.pdf", contentType: "application/pdf" })
        .attach("arquivos", DOCX_BYTES, {
          filename: "manual-operacao.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
        .attach("arquivos", Buffer.from(TXT_CONTEUDO, "utf8"), {
          filename: "observacoes.txt",
          contentType: "text/plain",
        })
      expect(res.status).toBe(201)
      expect(() => vitrinePedidoCriacaoRespostaSchema.parse(res.body)).not.toThrow()
      const corpo = vitrinePedidoCriacaoRespostaSchema.parse(res.body)
      expect(corpo.status).toBe("criado")
      expect(corpo.tokenAcompanhamento).toMatch(VITRINE_TOKEN_ACOMPANHAMENTO_REGEX)
      tokensCriados.push(corpo.tokenAcompanhamento)

      // Resposta não vaza nada interno nem caminho físico.
      const json = JSON.stringify(res.body)
      expect(json).not.toContain(DIR_DOCUMENTOS)
      expect(chavesVetadasNoJson(res.body)).toEqual([])

      // Banco: pedido 'criado', plano resolvido por NOME→id (nunca do payload),
      // fluxo intocado, consentimento gravado, token único.
      const pedido = (
        await pdb
          .select()
          .from(pedidos)
          .where(eq(pedidos.tokenAcompanhamento, corpo.tokenAcompanhamento))
          .limit(1)
      ).at(0)
      expect(pedido).toBeTruthy()
      expect(pedido!.status).toBe("criado")
      expect(Number(pedido!.planoId)).toBe(planoProId)
      expect(pedido!.nomeNegocio).toBe("Barbearia Navalha de Ouro")
      expect(pedido!.email).toBe("joao@navalhadeouro.com.br")
      expect(pedido!.telefone).toBe("(21) 98816-1553")
      expect(pedido!.ciclo).toBe("anual")
      expect(pedido!.consentimentoLgpd).toBe(true)
      expect(pedido!.pagamentoId).toBeNull()
      expect(pedido!.linkAgente).toBeNull()
      expect(pedido!.scriptEmbed).toBeNull()
      expect((await pdb.select({ id: pedidos.id }).from(pedidos).where(eq(pedidos.tokenAcompanhamento, corpo.tokenAcompanhamento))).length).toBe(1)

      // Banco: 3 arquivos + 1 texto_livre com chave lógica e conteúdo gravado.
      const docs = await pdb
        .select()
        .from(documentos)
        .where(eq(documentos.pedidoId, Number(pedido!.id)))
        .orderBy(documentos.id)
      expect(docs.map((d) => d.tipoConteudo)).toEqual(["pdf", "docx", "txt", "texto_livre"])
      const porTipo = Object.fromEntries(docs.map((d) => [d.tipoConteudo, d]))
      expect(porTipo.pdf.nomeOriginal).toBe("cardapio.pdf")
      expect(porTipo.pdf.mimeType).toBe("application/pdf")
      expect(Number(porTipo.pdf.tamanhoBytes)).toBe(PDF_BYTES.length)
      expect(String(porTipo.pdf.caminhoArmazenamento)).toMatch(/^pedido\/[0-9a-f-]+\/[0-9a-f-]+\.pdf$/)
      expect(porTipo.docx.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )
      expect(porTipo.txt.nomeOriginal).toBe("observacoes.txt")
      expect(porTipo.texto_livre.caminhoArmazenamento).toBeNull()
      expect(porTipo.texto_livre.textoExtraido).toBe(textoLivre)

      // Disco: os arquivos físicos EXISTEM sob VITRINE_DOCUMENTOS_DIR com o
      // conteúdo byte-a-byte fiel — e o texto_livre NÃO tem arquivo.
      for (const tipo of ["pdf", "docx", "txt"] as const) {
        const chave = String(porTipo[tipo].caminhoArmazenamento)
        const caminhoFisico = join(DIR_DOCUMENTOS, ...chave.split("/"))
        await expect(stat(caminhoFisico)).resolves.toBeTruthy()
        const esperado = tipo === "pdf" ? PDF_BYTES : tipo === "docx" ? DOCX_BYTES : Buffer.from(TXT_CONTEUDO, "utf8")
        expect(await readFile(caminhoFisico)).toEqual(esperado)
      }
    })

    it("pedido B sem arquivos (só textoLivre) → criado com exatamente 1 documento texto_livre", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .field("dados", dadosPedido({ nomeNegocio: "Pet Shop Amigo Fiel", email: "contato@petamigo.com.br" }))
        .field("textoLivre", "banho e tosa, 2 unidades, ticket medio R$ 90.")
      expect(res.status).toBe(201)
      const corpo = vitrinePedidoCriacaoRespostaSchema.parse(res.body)
      tokensCriados.push(corpo.tokenAcompanhamento)
      const pedido = (await pdb.select({ id: pedidos.id }).from(pedidos).where(eq(pedidos.tokenAcompanhamento, corpo.tokenAcompanhamento)).limit(1)).at(0)!
      const docs = await pdb.select().from(documentos).where(eq(documentos.pedidoId, Number(pedido.id)))
      expect(docs).toHaveLength(1)
      expect(docs[0]!.tipoConteudo).toBe("texto_livre")
      expect(docs[0]!.caminhoArmazenamento).toBeNull()
    })

    // ==========================================================================
    // Acompanhamento + isolamento
    // ==========================================================================

    it("GET pelo token do pedido A retorna SOMENTE o pedido A (allow-list) — nunca o B", async () => {
      const [tokenA, tokenB] = tokensCriados
      const resA = await request(app.getHttpServer()).get(`/api/vitrine/pedidos/${tokenA}`)
      expect(resA.status).toBe(200)
      expect(() => vitrinePedidoAcompanhamentoSchema.parse(resA.body)).not.toThrow()
      const corpo = vitrinePedidoAcompanhamentoSchema.parse(resA.body)
      expect(corpo.nomeNegocio).toBe("Barbearia Navalha de Ouro")
      expect(corpo.planoNome).toBe("Pro")
      expect(corpo.ciclo).toBe("anual")
      expect(corpo.status).toBe("criado")
      expect(corpo.documentos.map((d) => d.tipoConteudo)).toEqual(["pdf", "docx", "txt", "texto_livre"])
      expect(corpo.documentos.every((d) => typeof d.tamanhoBytes === "number" || d.tamanhoBytes === null)).toBe(true)
      // isolamento: o payload de A não menciona B nem vaza campos internos
      const jsonA = JSON.stringify(resA.body)
      expect(jsonA).not.toContain("Pet Shop Amigo Fiel")
      expect(jsonA).not.toContain(DIR_DOCUMENTOS)
      expect(jsonA).not.toContain("banho e tosa")
      expect(chavesVetadasNoJson(resA.body)).toEqual([])

      const resB = await request(app.getHttpServer()).get(`/api/vitrine/pedidos/${tokenB}`)
      expect(resB.status).toBe(200)
      expect(resB.body.nomeNegocio).toBe("Pet Shop Amigo Fiel")
      expect(JSON.stringify(resB.body)).not.toContain("Barbearia Navalha de Ouro")
    })

    it("token válido por formato mas inexistente → 404; token malformado → 404", async () => {
      const inventado = "f".repeat(64)
      expect(await request(app.getHttpServer()).get(`/api/vitrine/pedidos/${inventado}`)).toMatchObject({ status: 404 })
      const lixo = await request(app.getHttpServer()).get("/api/vitrine/pedidos/nao-e-um-token")
      expect(lixo.status).toBe(404)
    })

    it("NÃO existe listagem pública: GET /api/vitrine/pedidos nunca responde 200", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/pedidos")
      expect(res.status).not.toBe(200)
      expect([401, 403, 404]).toContain(res.status)
    })

    // ==========================================================================
    // Rejeições — sem efeito no banco
    // ==========================================================================

    it("extensão fora da whitelist (.exe) → 400 claro e nada persistido", async () => {
      const antes = await contarPedidos(pdb)
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .field("dados", dadosPedido({ nomeNegocio: "Tentativa Maliciosa" }))
        .attach("arquivos", Buffer.from("MZ\u0000\u0003"), { filename: "setup.exe", contentType: "application/octet-stream" })
      expect(res.status).toBe(400)
      expect(String(res.body.message)).toMatch(/não permitido/i)
      expect(await contarPedidos(pdb)).toBe(antes)
    })

    it(`arquivo acima do limite (${MAX_BYTES} bytes) → 400 citando o máximo (nunca 500), sem pedido e sem arquivo órfão`, async () => {
      const antes = await contarPedidos(pdb)
      const gigante = Buffer.alloc(MAX_BYTES + 4096, 0x42)
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .field("dados", dadosPedido({ nomeNegocio: "Tentativa Gigante" }))
        .attach("arquivos", gigante, { filename: "enorme.pdf", contentType: "application/pdf" })
      expect(res.status).toBe(400)
      expect(String(res.body.message)).toContain(String(MAX_BYTES))
      expect(await contarPedidos(pdb)).toBe(antes)
    })

    it.each([
      ["chave de fluxo 'status'", dadosPedido({ status: "pago" })],
      ["chave de fluxo 'pagamentoId'", dadosPedido({ pagamentoId: "MP-1" })],
      ["chave de fluxo 'linkAgente'", dadosPedido({ linkAgente: "https://x" })],
      ["chave de fluxo 'scriptEmbed'", dadosPedido({ scriptEmbed: "<script/>" })],
      ["chave interna 'planoId' numérico", dadosPedido({ planoId: 99 })],
      ["e-mail inválido", dadosPedido({ email: "sem-arroba" })],
      ["telefone fora da regra BR", dadosPedido({ telefone: "12345" })],
      ["consentimento LGPD ausente", dadosPedido(undefined, ["consentimentoLgpd"])],
      ["consentimento false", dadosPedido({ consentimentoLgpd: false })],
      ["ciclo inválido", dadosPedido({ ciclo: "vitalicio" })],
      ["plano inexistente", dadosPedido({ plano: "Plano Que Nao Existe" })],
      ["falta campo obrigatório", dadosPedido(undefined, ["nomeNegocio"])],
      ["JSON malformado", "{quebrado"],
    ])("payload inválido (%s) → 400 com mensagem clara e nada persistido", async (_titulo, dados) => {
      const antes = await contarPedidos(pdb)
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .field("dados", dados)
      expect(res.status).toBe(400)
      expect(String(res.body.message)).toBeTruthy()
      expect(await contarPedidos(pdb)).toBe(antes)
    })

    it("dados ausente no multipart → 400 citando 'dados'", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/vitrine/pedidos")
        .attach("arquivos", Buffer.from("oi"), { filename: "a.txt", contentType: "text/plain" })
      expect(res.status).toBe(400)
      expect(String(res.body.message)).toMatch(/'dados'/)
    })

    it("regressão: rota estática continua vencendo o CRUD (GET /api/vitrine/conteudo 200)", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty("planos")
    })

    it("confirmação cirúrgica: cada pedido criado tem exatamente os documentos prometidos", async () => {
      const ids = tokensCriados.length
        ? (await pdb.select({ id: pedidos.id }).from(pedidos).where(inArray(pedidos.tokenAcompanhamento, tokensCriados))).map((r) => Number(r.id))
        : []
      expect(ids.length).toBe(tokensCriados.length)
      const docs = await pdb
        .select({ id: documentos.id, pedidoId: documentos.pedidoId })
        .from(documentos)
        .where(inArray(documentos.pedidoId, ids))
      // A = 3 arquivos + texto_livre; B = só texto_livre → 5 no total.
      expect(docs).toHaveLength(5)
    })
  },
)
