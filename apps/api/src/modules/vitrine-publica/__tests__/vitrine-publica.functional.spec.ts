// @vitest-environment node
/**
 * Teste FUNCIONAL do endpoint público da vitrine (macro #10, posição 2/11)
 * contra o ambiente real (Nest bootado + MySQL `projeto_8509`), no padrão
 * das suítes `*.functional.spec.ts` (excluídas do `npm test`; rodadas
 * separadamente com os envs da raiz). Execução ad-hoc:
 *   set -a; source <raiz>/.env; set +a
 *   export MYSQL_HOST=host.docker.internal PSP_PROVIDER=mercadopago \
 *          PSP_ACCESS_TOKEN=*** PSP_WEBHOOK_SECRET=***
 *   npx vitest run --config <config temporário com include apontando p/ este
 *   arquivo>   (a config raiz exclui *.functional.spec.ts de propósito)
 *
 * Cobre os critérios de aceite que exigem stack real:
 * - `GET /api/vitrine/conteudo` responde 200 SEM token (mesmo com header
 *   Authorization lixo — a rota ignora auth);
 * - a resposta parseia integralmente no zod schema compartilhado;
 * - somente linhas `ativo = true` saem, ordenadas por ordem (desativação via
 *   banco some da resposta e volta ao reativar — "mudança no painel reflete
 *   sem redeploy");
 * - nenhum campo interno (id, ativo, ordens, pedidos, credenciais, fluxos)
 *   aparece em NENHUM nível do JSON;
 * - `whatsapp_link` presente (botões usam o link centralizado);
 * - sem colisão: a rota é atendida pelo módulo específico, não pelo CRUD
 *   dinâmico (que devolveria 401/404 para slug inexistente).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Test } from "@nestjs/testing"
import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { eq } from "drizzle-orm"
import { vitrinePublicaConteudoSchema } from "@biblioteca-global/shared"
import { planos } from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { projetos } from "../../../../../../database/schema"
import { AppModule } from "../../../app.module"
import { configureApp } from "../../../bootstrap"
import { CORE_DB, type CoreDb } from "../../../database/database.module"
import { PROJECT_DB_FACTORY, type ProjectDbFactory, type ProjetoDb } from "../../crud/project-db.factory"
import { SLUG_VITRINE_IA } from "../../crud/escopo/vitrine-ia.escopo"

const hasMysql = Boolean(process.env.MYSQL_HOST)

/** Chaves internas que jamais podem aparecer no payload público. */
const CAMPOS_VETADOS = new Set([
  "id", "ativo", "ordem",
  "nome_negocio", "nomeNegocio", "nome_contato", "nomeContato", "email", "telefone",
  "plano_id", "planoId", "ciclo", "informacoes_negocio", "informacoesNegocio",
  "status", "pagamento_id", "pagamentoId", "link_agente", "linkAgente",
  "script_embed", "scriptEmbed", "consentimento_lgpd", "consentimentoLgpd",
  "criado_em", "criadoEm", "em_atualizacao", "emAtualizacao", "pedido_id", "pedidoId",
  "nome_original", "nomeOriginal", "mime_type", "mimeType", "tamanho_bytes",
  "tamanhoBytes", "caminho_armazenamento", "caminhoArmazenamento", "tipo_conteudo",
  "tipoConteudo", "texto_extraido", "textoExtraido", "openclaw_agente_id",
  "openclawAgenteId", "personalidade", "link_acesso", "linkAcesso", "tentativas",
  "ultimo_erro", "ultimoErro", "url_base", "urlBase", "tipo_autenticacao",
  "tipoAutenticacao", "credenciais_cifradas", "credenciaisCifradas", "headers",
  "limite_requisicoes_minuto", "limiteRequisicoesMinuto", "somente_leitura",
  "somenteLeitura", "agente_id", "agenteId", "status_pareamento", "statusPareamento",
  "alcance", "numeros_permitidos", "numerosPermitidos", "ultimo_qr_gerado_em",
  "ultimoQrGeradoEm",
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

describe.skipIf(!hasMysql)(
  "GET /api/vitrine/conteudo — endpoint público (macro #10, posição 2/11)",
  () => {
    let app: INestApplication
    let pdb: ProjetoDb
    let planoDesativadoId: number | null = null

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
    })

    afterAll(async () => {
      // Segurança: restaura qualquer ativo mexido no teste.
      if (planoDesativadoId !== null) {
        await pdb.update(planos).set({ ativo: true }).where(eq(planos.id, planoDesativadoId))
      }
      await app?.close()
    })

    it("responde 200 sem token e o corpo parseia no contrato compartilhado", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("application/json")
      expect(() => vitrinePublicaConteudoSchema.parse(res.body)).not.toThrow()
      expect(Object.keys(res.body).sort()).toEqual(["faq", "metricas", "planos", "segmentos", "textos"])
    })

    it("ignora Authorization inválida (rota pública de verdade)", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/vitrine/conteudo")
        .set("Authorization", "***")
      expect(res.status).toBe(200)
    })

    it("não é servida pelo CRUD dinâmico (sem 401/404 de slug desconhecido)", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty("planos")
    })

    it("conteúdo ativo canônico presente e ordenado (reflete o banco sem redeploy)", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
      const corpo = vitrinePublicaConteudoSchema.parse(res.body)
      // planos ativos em ordem (ordem/id): Starter(1), Pro(2), Enterprise(3)
      expect(corpo.planos.map((p) => p.nome)).toEqual(["Starter", "Pro", "Enterprise"])
      expect(corpo.planos.find((p) => p.nome === "Pro")?.maisPopular).toBe(true)
      expect(corpo.metricas.length).toBeGreaterThanOrEqual(3)
      expect(corpo.faq.length).toBeGreaterThanOrEqual(5)
      expect(corpo.segmentos.length).toBeGreaterThanOrEqual(6)
      const link = corpo.textos.find((t) => t.chave === "whatsapp_link")
      expect(link?.conteudo).toMatch(/^https:\/\/(wa\.me|api\.whatsapp\.com)/)
      expect(corpo.textos.map((t) => t.secao)).toContain("hero")
    })

    it("desativar uma linha no banco some da resposta pública (e volta ao reativar)", async () => {
      const alvo = (await pdb.select({ id: planos.id, nome: planos.nome }).from(planos).where(eq(planos.ativo, true)).limit(1)).at(0)
      expect(alvo).toBeTruthy()
      planoDesativadoId = Number(alvo!.id)
      try {
        await pdb.update(planos).set({ ativo: false }).where(eq(planos.id, planoDesativadoId))
        const depois = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
        const nomes = (depois.body as { planos: Array<{ nome: string }> }).planos.map((p) => p.nome)
        expect(nomes).not.toContain(alvo!.nome)

        await pdb.update(planos).set({ ativo: true }).where(eq(planos.id, planoDesativadoId))
        planoDesativadoId = null
        const restaurado = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
        const nomesOk = (restaurado.body as { planos: Array<{ nome: string }> }).planos.map((p) => p.nome)
        expect(nomesOk).toContain(alvo!.nome)
      } finally {
        if (planoDesativadoId !== null) {
          await pdb.update(planos).set({ ativo: true }).where(eq(planos.id, planoDesativadoId))
          planoDesativadoId = null
        }
      }
    })

    it("nenhum campo interno aparece em nenhum nível do JSON", async () => {
      const res = await request(app.getHttpServer()).get("/api/vitrine/conteudo")
      expect(chavesVetadasNoJson(res.body)).toEqual([])
    })
  },
)
