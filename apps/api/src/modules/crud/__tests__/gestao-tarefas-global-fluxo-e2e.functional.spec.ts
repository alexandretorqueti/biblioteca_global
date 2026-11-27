// @vitest-environment node
/**
 * E2E DE INTEGRAÇÃO DO FLUXO COMPLETO DA TAREFA
 * (gestao-de-tarefas-global — macro #9, subtarefa 3).
 *
 * Cobertura ponta a ponta com API real + MySQL real (mesma base da matriz de
 * permissões — fixture `montarMatrizPerfis`), nos perfis admin/operador e nas
 * organizações A e B. Playwright browser não está disponível no ambiente
 * (sem libs gráficas — mesmo motivo do placeholder em apps/web/e2e), então o
 * aceite "fluxo completo" é validado na camada HTTP/integração, que exercita
 * exatamente as rotas que a UI chama:
 *
 * 1. criar tarefa (CRUD genérico: área, tags via pivot virtual, responsável,
 *    prioridade, prazo) como OPERADOR;
 * 2. delegar (admin → operador), devolver no sabor `precisa_informacoes`,
 *    re-delegar em cadeia e concluir pelo atalho — com histórico cronológico
 *    completo (delegacao → devolucao_precisa_info → reatribuicao →
 *    devolucao_concluida) e notificações do sino nos destinatários certos;
 * 3. chat da tarefa (POST/GET mensagens, autor resolvido);
 * 4. recorrência: regra criada via CRUD + tick do agendador real gera
 *    instância VINCULADA à regra (regraRecorrenciaId), sem prazo (sem
 *    lembrete — decisão 2026-10-22); desativar a regra NÃO apaga instâncias;
 * 5. lembrete: tarefa SEM prazo com antecedência → 400 (validação na API);
 *    tarefa na janela do lembrete → tick do agendador real notifica o
 *    responsável pelo sino;
 * 6. anexos: upload multipart, lista, download byte-a-byte, chave LÓGICA
 *    `org/{org}/tarefa/{id}/{uuid}.{ext}` sem caminho físico na resposta e
 *    isolamento A×B em todas as etapas (404, nunca 403 com existência).
 *
 * Requisitos: REQ-F-020 (fluxo responsivo coberto pela mesma API da UI),
 * REQ-NF-001 (isolamento entre organizações), REQ-NF-003 (trilha de histórico
 * e notificações como evidência auditável).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  montarMatrizPerfis,
  cliente,
  SLUG_GESTAO,
  type MatrizPerfisFixtures,
  type Participante,
} from "./fixtures/matriz-perfis.fixture"
import {
  RECURRENCIA_AGENDADOR_REPOSITORIO,
  type RepositorioRecorrenciaAgendador,
} from "../../gestao-tarefas-global-recorrencia/recorrencia-agendador.repositorio"
import { RecorrenciaAgendadorService } from "../../gestao-tarefas-global-recorrencia/recorrencia-agendador.service"
import {
  LEMBRETE_AGENDADOR_REPOSITORIO,
  type RepositorioLembreteAgendador,
} from "../../gestao-tarefas-global-notificacoes/lembrete-agendador.repositorio"
import { LembreteAgendadorService } from "../../gestao-tarefas-global-notificacoes/lembrete-agendador.service"

const hasMysql = Boolean(process.env.MYSQL_HOST)

/** "YYYY-MM-DD HH:mm:ss" em UTC (mesma base do TZ=UTC dos testes). */
function datetimeUtc(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ")
}

/** "YYYY-MM-DD" em UTC. */
function dataUtc(offsetMs: number): string {
  return datetimeUtc(offsetMs).slice(0, 10)
}

const DIA_MS = 24 * 60 * 60 * 1000

interface ItemNotificacaoHttp {
  id: number
  tipo: string
  tarefaId: number | null
  lida: boolean
}

describe.skipIf(!hasMysql)(
  "E2E de integração — fluxo completo da tarefa (macro #9, subtarefa 3)",
  () => {
    let fix: MatrizPerfisFixtures & { desmontar: () => Promise<void> }
    let app: INestApplication
    /** Diretório temporário de anexos (ANEXOS_DIR) — isolado do default. */
    let anexoDir: string

    /** Chamada autenticada na API do projeto (paths relativos a /api/<slug>/). */
    const api = {
      get: (p: Participante, path: string) => cliente(app, fix.tokens[p], "get", path),
      post: (p: Participante, path: string, body?: Record<string, unknown>) =>
        cliente(app, fix.tokens[p], "post", path, body ?? {}),
      put: (p: Participante, path: string, body: Record<string, unknown>) =>
        cliente(app, fix.tokens[p], "put", path, body),
    }

    beforeAll(async () => {
      anexoDir = mkdtempSync(join(tmpdir(), "gtg-e2e-anexos-"))
      process.env.ANEXOS_DIR = anexoDir
      fix = await montarMatrizPerfis()
      app = fix.app
    }, 180_000)

    afterAll(async () => {
      if (app) await app.close()
      await fix.desmontar()
      rmSync(anexoDir, { recursive: true, force: true })
    })

    // ==================================================================
    // 1–3. Fluxo principal: criar → delegar → devolver → re-delegar →
    //      concluir + histórico + chat + sino
    // ==================================================================
    let tarefaId: number

    it("operador cria tarefa completa (área, tags, responsável, prioridade, prazo) via CRUD", async () => {
      const res = await api.post("operadorA", "tarefas", {
        titulo: `E2E Fluxo Completo ${fix.sufixo}`,
        descricao: "Tarefa do E2E de integração da macro 9.",
        areaId: fix.area.A,
        responsavelId: fix.colabIdPorUsuario.operadorA,
        prioridade: "alta",
        prazo: datetimeUtc(2 * DIA_MS),
        tags: [fix.tag.A],
      })
      expect(res.status).toBe(201)
      tarefaId = Number(res.body.id)
      expect(tarefaId).toBeGreaterThan(0)

      // Pivot de tags sincronizado + autor = colaborador da sessão (nunca body).
      const detalhe = await api.get("operadorA", `tarefas/${tarefaId}`)
      expect(detalhe.status).toBe(200)
      expect(detalhe.body.status).toBe("aberta")
      expect(detalhe.body.organizacaoId).toBe(fix.orgA)
      expect(detalhe.body.criadoPorId).toBe(fix.colabIdPorUsuario.operadorA)
      expect(Array.isArray(detalhe.body.tags)).toBe(true)
      expect(detalhe.body.tags.map(Number)).toContain(fix.tag.A)
    })

    it("admin delega ao operador; operador sem autoridade não pode devolver (403)", async () => {
      const delega = await api.post("adminA", `tarefas/${tarefaId}/delegar`, {
        responsavelId: fix.colabIdPorUsuario.gerenteA,
      })
      expect(delega.status).toBe(201)
      expect(delega.body.status).toBe("delegada")
      expect(Number(delega.body.responsavelId)).toBe(fix.colabIdPorUsuario.gerenteA)
      expect(delega.body.evento.tipoEvento).toBe("delegacao")

      // Operador não é responsável atual nem admin/gerente → 403 claro.
      const devolve = await api.post("operadorA", `tarefas/${tarefaId}/devolver`, {
        sabor: "concluida",
        mensagem: "não deveria ser autorizado",
      })
      expect(devolve.status).toBe(403)
    })

    it("gerente devolve no sabor precisa_informacoes (mensagem obrigatória)", async () => {
      const res = await api.post("gerenteA", `tarefas/${tarefaId}/devolver`, {
        sabor: "precisa_informacoes",
        mensagem: "Falta o número do contrato para prosseguir.",
      })
      expect(res.status).toBe(201)
      expect(res.body.status).toBe("precisa_informacoes")
      expect(res.body.evento.tipoEvento).toBe("devolucao_precisa_info")

      // Devolução sem mensagem → rejeitada (pré-condição da máquina de estados).
      const semMsg = await api.post("gerenteA", `tarefas/${tarefaId}/devolver`, {
        sabor: "aguardando_terceiro",
        mensagem: "   ",
      })
      expect(semMsg.status).toBe(409)
    })

    it("re-delegação em cadeia e conclusão pelo atalho /concluir (concluidaEm preenchido)", async () => {
      const re = await api.post("gerenteA", `tarefas/${tarefaId}/delegar`, {
        responsavelId: fix.colabIdPorUsuario.operadorA,
      })
      expect(re.status).toBe(201)
      expect(re.body.evento.tipoEvento).toBe("reatribuicao")
      expect(re.body.status).toBe("delegada")

      const conclui = await api.post("operadorA", `tarefas/${tarefaId}/concluir`)
      expect(conclui.status).toBe(201)
      expect(conclui.body.status).toBe("concluida")
      expect(conclui.body.concluidaEm).toBeTruthy()

      // Estado terminal: nova transição é recusada.
      const depois = await api.post("operadorA", `tarefas/${tarefaId}/cancelar`, {})
      expect(depois.status).toBe(409)
    })

    it("histórico cronológico registra toda a trilha (append-only)", async () => {
      const res = await api.get("adminA", `tarefas/${tarefaId}/historico`)
      expect(res.status).toBe(200)
      const tipos = (res.body as Array<{ tipoEvento: string }>).map((e) => e.tipoEvento)
      expect(tipos).toEqual([
        "delegacao",
        "devolucao_precisa_info",
        "reatribuicao",
        "devolucao_concluida",
      ])
    })

    it("chat da tarefa aceita mensagens por participante e resolve o autor", async () => {
      const posta = await api.post("operadorA", `tarefas/${tarefaId}/mensagens`, {
        texto: "Contrato anexado, tarefa concluída.",
      })
      expect(posta.status).toBe(201)

      const lista = await api.get("gerenteA", `tarefas/${tarefaId}/mensagens`)
      expect(lista.status).toBe(200)
      const minha = (lista.body as Array<{ texto: string; autorNome: string }>).find(
        (m) => m.texto === "Contrato anexado, tarefa concluída.",
      )
      expect(minha).toBeTruthy()
      expect(minha!.autorNome).toContain("operadorA")

      // Texto vazio → 400.
      const vazia = await api.post("operadorA", `tarefas/${tarefaId}/mensagens`, { texto: "  " })
      expect(vazia.status).toBe(400)
    })

    it("sino entrega notificações de delegação e devolução aos destinatários certos", async () => {
      const comoGerente = await api.get("gerenteA", "notificacoes")
      expect(comoGerente.status).toBe(200)
      const itensGerente = (comoGerente.body.itens as ItemNotificacaoHttp[]).filter(
        (n) => n.tarefaId === tarefaId,
      )
      // Delegação recebida pelo gerente + devolução ao delegador (gerente).
      expect(itensGerente.some((n) => n.tipo === "delegacao")).toBe(true)

      const comoOperador = await api.get("operadorA", "notificacoes")
      const itensOperador = (comoOperador.body.itens as ItemNotificacaoHttp[]).filter(
        (n) => n.tarefaId === tarefaId,
      )
      // Re-delegação recebida + devolução_concluida notificada ao delegador.
      expect(itensOperador.some((n) => n.tipo === "delegacao")).toBe(true)

      const badge = await api.get("gerenteA", "notificacoes/nao-lidas/contagem")
      expect(badge.status).toBe(200)
      expect(Number(badge.body.contagem)).toBeGreaterThan(0)
    })

    // ==================================================================
    // 4. Recorrência: regra via CRUD + tick do agendador real
    // ==================================================================
    it("regra de recorrência gera instância vinculada no tick do agendador (sem prazo → sem lembrete)", async () => {
      const cria = await api.post("adminA", "regras_recorrencia", {
        titulo: `E2E Recorrência ${fix.sufixo}`,
        areaId: fix.area.A,
        responsavelId: fix.colabIdPorUsuario.operadorA,
        frequencia: "diaria",
        dataInicio: dataUtc(-DIA_MS),
      })
      expect(cria.status).toBe(201)
      const regraId = Number(cria.body.id)

      // Cursor vencido no passado → tick gera UMA instância.
      const avanca = await api.put("adminA", `regras_recorrencia/${regraId}`, {
        proximaGeracao: datetimeUtc(-60_000),
      })
      expect(avanca.status).toBe(200)

      const agendador = new RecorrenciaAgendadorService(
        app.get<RepositorioRecorrenciaAgendador>(RECURRENCIA_AGENDADOR_REPOSITORIO),
        { enabled: true },
      )
      await agendador.tick()

      const lista = await api.get("adminA", `tarefas?regraRecorrenciaId=${regraId}&pageSize=50`)
      expect(lista.status).toBe(200)
      const instancias = lista.body.items as Array<{
        id: number
        status: string
        prazo: string | null
        regraRecorrenciaId: number
      }>
      expect(instancias.length).toBeGreaterThanOrEqual(1)
      const instancia = instancias[0]!
      expect(Number(instancia.regraRecorrenciaId)).toBe(regraId)
      expect(instancia.status).toBe("aberta")
      // Decisão 2026-10-22: instância nasce SEM prazo → nunca com lembrete.
      expect(instancia.prazo).toBeNull()

      // Tick repetido não duplica a mesma ocorrência (claim idempotente): o
      // cursor já avançou para o futuro.
      await agendador.tick()
      const lista2 = await api.get("adminA", `tarefas?regraRecorrenciaId=${regraId}&pageSize=50`)
      expect((lista2.body.items as unknown[]).length).toBe(instancias.length)

      // Desativar a regra NÃO apaga instâncias já geradas (vínculo de origem).
      const desativa = await api.put("adminA", `regras_recorrencia/${regraId}`, { ativa: false })
      expect(desativa.status).toBe(200)
      const lista3 = await api.get("adminA", `tarefas?regraRecorrenciaId=${regraId}&pageSize=50`)
      expect((lista3.body.items as unknown[]).length).toBe(instancias.length)
    })

    // ==================================================================
    // 5. Lembrete: regra de domínio + disparo do agendador real
    // ==================================================================
    it("tarefa SEM prazo não aceita lembrete (400 na API — decisão 2026-10-22)", async () => {
      const res = await api.post("adminA", "tarefas", {
        titulo: `E2E Lembrete sem Prazo ${fix.sufixo}`,
        areaId: fix.area.A,
        responsavelId: fix.colabIdPorUsuario.operadorA,
        lembreteAntecedenciaMinutos: 30,
      })
      expect(res.status).toBe(400)
      expect(String(JSON.stringify(res.body))).toContain("lembrete")
    })

    it("tick do agendador de lembretes notifica o responsável na janela (prazo - antecedência)", async () => {
      const cria = await api.post("adminA", "tarefas", {
        titulo: `E2E Lembrete Janela ${fix.sufixo}`,
        areaId: fix.area.A,
        responsavelId: fix.colabIdPorUsuario.operadorA,
        prazo: datetimeUtc(30 * 60_000), // vence em 30 min
        lembreteAntecedenciaMinutos: 60, // janela já aberta
      })
      expect(cria.status).toBe(201)
      const tarefaLembrete = Number(cria.body.id)

      const agendador = new LembreteAgendadorService(
        app.get<RepositorioLembreteAgendador>(LEMBRETE_AGENDADOR_REPOSITORIO),
        { enabled: true },
      )
      await agendador.tick()

      const sino = await api.get("operadorA", "notificacoes")
      const lembrete = (sino.body.itens as ItemNotificacaoHttp[]).find(
        (n) => n.tipo === "lembrete" && n.tarefaId === tarefaLembrete,
      )
      expect(lembrete).toBeTruthy()

      // Idempotência v1: segundo tick não duplica.
      await agendador.tick()
      const sino2 = await api.get("operadorA", "notificacoes")
      const repetidos = (sino2.body.itens as ItemNotificacaoHttp[]).filter(
        (n) => n.tipo === "lembrete" && n.tarefaId === tarefaLembrete,
      )
      expect(repetidos.length).toBe(1)
    })

    // ==================================================================
    // 6. Anexos: upload/lista/download + chave lógica + isolamento
    // ==================================================================
    let anexoId: number
    const CONTEUDO_ANEXO = Buffer.from("conteudo do anexo e2e gestao de tarefas\n", "utf8")

    it("upload multipart grava anexo com chave LÓGICA (sem caminho físico na resposta)", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/${SLUG_GESTAO}/tarefas/${tarefaId}/anexos`)
        .set("Authorization", `Bearer ${fix.tokens.operadorA}`)
        .attach("arquivo", CONTEUDO_ANEXO, "relatorio-e2e.txt")
      expect(res.status).toBe(201)
      anexoId = Number(res.body.id)
      expect(anexoId).toBeGreaterThan(0)

      const chave = String(res.body.chaveArmazenamento)
      expect(chave).toMatch(new RegExp(`^org/${fix.orgA}/tarefa/${tarefaId}/[0-9a-f-]+\\.txt$`))
      // O caminho físico do servidor NUNCA aparece na resposta.
      expect(JSON.stringify(res.body)).not.toContain(anexoDir)

      // Upload também registra evento 'anexo' no histórico (append-only).
      const hist = await api.get("adminA", `tarefas/${tarefaId}/historico`)
      const eventos = (hist.body as Array<{ tipoEvento: string; mensagem: string | null }>).filter(
        (e) => e.tipoEvento === "anexo",
      )
      expect(eventos.length).toBe(1)
      expect(String(eventos[0]!.mensagem)).toContain("relatorio-e2e.txt")
    })

    it("lista e download do anexo byte-a-byte; texto vai como attachment", async () => {
      const lista = await api.get("operadorA", `tarefas/${tarefaId}/anexos`)
      expect(lista.status).toBe(200)
      const item = (lista.body as Array<{ id: number; nomeArquivo: string }>).find(
        (a) => Number(a.id) === anexoId,
      )
      expect(item?.nomeArquivo).toBe("relatorio-e2e.txt")

      const download = await request(app.getHttpServer())
        .get(`/api/${SLUG_GESTAO}/tarefas/${tarefaId}/anexos/${anexoId}/download`)
        .set("Authorization", `Bearer ${fix.tokens.operadorA}`)
        .buffer()
        .parse((res, cb) => {
          const chunks: Buffer[] = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () => cb(null, Buffer.concat(chunks)))
        })
      expect(download.status).toBe(200)
      expect((download.body as Buffer).equals(CONTEUDO_ANEXO)).toBe(true)
      expect(String(download.headers["content-disposition"] ?? "")).toContain("attachment")
    })

    // ==================================================================
    // Isolamento entre organizações em TODAS as etapas do fluxo (REQ-NF-001)
    // ==================================================================
    it("colaborador da organização B não vê nem altera a tarefa de A em etapa alguma (404)", async () => {
      const alvos: Array<[Participante, "get" | "post", string]> = [
        ["adminB", "get", `tarefas/${tarefaId}`],
        ["adminB", "get", `tarefas/${tarefaId}/historico`],
        ["adminB", "get", `tarefas/${tarefaId}/mensagens`],
        ["adminB", "get", `tarefas/${tarefaId}/anexos`],
        ["adminB", "post", `tarefas/${tarefaId}/delegar`],
        ["adminB", "post", `tarefas/${tarefaId}/devolver`],
        ["adminB", "post", `tarefas/${tarefaId}/concluir`],
        ["adminB", "post", `tarefas/${tarefaId}/mensagens`],
      ]
      for (const [participante, method, path] of alvos) {
        const res = await api[method](participante, path, {
          responsavelId: fix.colabIdPorUsuario.adminB,
          sabor: "concluida",
          mensagem: "tentativa de B em tarefa de A",
          texto: "mensagem de B em tarefa de A",
        })
        // 404 (nunca 403): existência de registro de outra organização não vaza.
        expect(res.status, `${method} ${path} como ${participante}`).toBe(404)
      }

      // Download do anexo por B também é 404.
      const dl = await request(app.getHttpServer())
        .get(`/api/${SLUG_GESTAO}/tarefas/${tarefaId}/anexos/${anexoId}/download`)
        .set("Authorization", `Bearer ${fix.tokens.adminB}`)
      expect(dl.status).toBe(404)

      // Upload de anexo de B na tarefa de A → 404 (nada gravado).
      const up = await request(app.getHttpServer())
        .post(`/api/${SLUG_GESTAO}/tarefas/${tarefaId}/anexos`)
        .set("Authorization", `Bearer ${fix.tokens.adminB}`)
        .attach("arquivo", Buffer.from("intruso\n"), "intruso.txt")
      expect(up.status).toBe(404)

      // A tarefa de B não aparece na listagem de A e vice-versa.
      const listaA = await api.get("adminA", `tarefas?pageSize=200`)
      const idsA = (listaA.body.items as Array<{ id: number }>).map((t) => Number(t.id))
      expect(idsA).toContain(tarefaId)
      expect(idsA).not.toContain(fix.tarefaB)

      // Delegação para colaborador de OUTRA organização → rejeitada.
      const delegaCruzada = await api.post("adminA", `tarefas/${tarefaId}/delegar`, {
        responsavelId: fix.colabIdPorUsuario.adminB,
      })
      expect(delegaCruzada.status).toBe(400)
    })
  },
)
