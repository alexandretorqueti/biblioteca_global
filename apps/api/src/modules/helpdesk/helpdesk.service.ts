/**
 * helpdesk.service.ts — Lógica de negócio do HelpDesk.
 *
 * Orquestra persistência (core db via ProjectDbFactory), resolução de agente
 * do projeto (projetosCaptados.agenteId + projetoModelChain) e ponte com o
 * BFF OpenClaw (HelpDeskBridgeService).
 */
import { Injectable, Inject, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { eq, desc, asc } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { sql } from "drizzle-orm"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import * as coreSchema from "../../../../../database/schema"
import { projetosCaptados, projetoModelChain } from "../../../../../projects/gerenteagentes/schema"
import { HelpDeskBridgeService } from "./helpdesk.bridge"

const { helpdeskSessoes: helpDeskSessionTable, helpdeskMensagens: helpDeskMessageTable } = coreSchema

@Injectable()
export class HelpDeskService {
  private readonly logger = new Logger(HelpDeskService.name)
  private readonly defaultAgentId = "biblioteca-global"
  private coreProjId: number

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    private readonly bridge: HelpDeskBridgeService,
    private readonly configService: ConfigService,
  ) {
    this.coreProjId = Number(this.configService.get<string>("HELPDESK_CORE_PROJECT_ID")) || 1
  }

  private async getCoreDb(): Promise<MySql2Database> {
    return this.factory.obter({ id: this.coreProjId })
  }

  // ===========================================================================
  // SESSÃO
  // ===========================================================================

  /** Cria ou retoma sessão: retorna sessaoId + agenteId do projeto. */
  async criarOuRetomarSessao(input: {
    usuarioId: number
    projetoId: number
  }): Promise<{ ok: true; sessaoId: number; agenteId: string }> {
    const db = await this.getCoreDb()

    const [existing] = await db
      .select()
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.usuarioId, input.usuarioId))
      .orderBy(desc(helpDeskSessionTable.updatedAt))
      .limit(1)

    if (existing && existing.status === "active") {
      return { ok: true, sessaoId: existing.id, agenteId: existing.agenteId }
    }

    const agenteId = await this.resolverAgenteDoProjeto(input.projetoId)

    const [inserted] = await db
      .insert(helpDeskSessionTable)
      .values({
        usuarioId: input.usuarioId,
        projetoId: input.projetoId,
        agenteId,
        status: "active",
      })
      .$returningId()

    if (!inserted) throw new Error("Falha ao criar sessão HelpDesk")

    this.logger.log(`Sessão HelpDesk criada u=${input.usuarioId} p=${input.projetoId} agente=${agenteId}`)
    return { ok: true, sessaoId: inserted.id, agenteId }
  }

  /** Obtém a sessão ativa (para verificação rápida). */
  async obterSessaoAtiva(input: { usuarioId: number }): Promise<
    | { ok: true; sessaoId: number; agenteId: string; projetoId: number }
    | { ok: false; reason: "not_found" }
  > {
    const db = await this.getCoreDb()

    const [existing] = await db
      .select({
        id: helpDeskSessionTable.id,
        agenteId: helpDeskSessionTable.agenteId,
        projetoId: helpDeskSessionTable.projetoId,
        status: helpDeskSessionTable.status,
      })
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.usuarioId, input.usuarioId))
      .orderBy(desc(helpDeskSessionTable.updatedAt))
      .limit(1)

    if (!existing || existing.status !== "active") {
      return { ok: false, reason: "not_found" }
    }
    return { ok: true, sessaoId: existing.id, agenteId: existing.agenteId, projetoId: existing.projetoId }
  }

  // ===========================================================================
  // ENVIO DE MENSAGEM
  // ===========================================================================

  /** Envia mensagem ao agente do projeto e persiste resposta. */
  async enviarMensagem(input: {
    sessaoId: number
    text: string
    usuarioId: number
  }): Promise<{ ok: boolean; messageId?: string; reason?: "offline" | "session_not_found"; retryable?: boolean }> {
    const db = await this.getCoreDb()

    const [sessao] = await db
      .select()
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.id, input.sessaoId))
      .limit(1)

    if (!sessao || sessao.status !== "active") {
      return { ok: false, reason: "session_not_found" }
    }

    // Persiste mensagem do usuário ANTES de enviar ao agente
    await db.insert(helpDeskMessageTable).values({
      sessaoId: input.sessaoId,
      role: "user",
      text: input.text.trim(),
    })

    if (!this.bridge.isConfigured()) {
      return { ok: false, reason: "offline" }
    }

    const agenteId = sessao.agenteId
    const modelChain = await this.obterCadeiaModelos(sessao.projetoId, "analista")
    if (modelChain.length === 0) {
      return { ok: false, reason: "offline" }
    }

    // Resolve/cria sessão no BFF
    const resolved = await this.bridge.resolveSession({
      agenteId,
      usuarioId: input.usuarioId,
      projetoId: sessao.projetoId,
    })

    // Fallback em cadeia de modelos
    const sendResult = await this.bridge.sendWithChain({
      sessionKey: resolved.sessionKey,
      text: input.text.trim(),
      modelChain,
    })

    if (sendResult.ok) {
      const respostaAgente = sendResult.messageId ?? ""
      await db.insert(helpDeskMessageTable).values({
        sessaoId: input.sessaoId,
        role: "agent",
        text: respostaAgente,
      })

      // Detecta solicitação de mudança e cria tarefa draft no projeto
      this.detectarECriarTarefa(sessao.projetoId, input.text.trim()).catch(() => {})

      return { ok: true, messageId: sendResult.messageId }
    }

    return { ok: false, reason: "offline", retryable: false }
  }

  // ===========================================================================
  // HISTÓRICO
  // ===========================================================================

  async obterHistorico(sessaoId: number): Promise<{
    sessao: {
      id: number
      usuarioId: number
      projetoId: number
      agenteId: string
      status: "active" | "closed"
      createdAt: string
      updatedAt: string
    }
    mensagens: Array<{
      id: number
      sessaoId: number
      role: "agent" | "user" | "system"
      text: string
      createdAt: string
    }>
  }> {
    const db = await this.getCoreDb()

    const [sessao] = await db
      .select()
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.id, sessaoId))
      .limit(1)

    if (!sessao) {
      return {
        sessao: { id: sessaoId, usuarioId: 0, projetoId: 0, agenteId: "", status: "closed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        mensagens: [],
      }
    }

    const msgs = await db
      .select()
      .from(helpDeskMessageTable)
      .where(eq(helpDeskMessageTable.sessaoId, sessaoId))
      .orderBy(asc(helpDeskMessageTable.createdAt))

    return {
      sessao: {
        id: sessao.id,
        usuarioId: sessao.usuarioId,
        projetoId: sessao.projetoId,
        agenteId: String(sessao.agenteId),
        status: sessao.status,
        createdAt: sessao.createdAt instanceof Date ? sessao.createdAt.toISOString() : String(sessao.createdAt),
        updatedAt: sessao.updatedAt instanceof Date ? sessao.updatedAt.toISOString() : String(sessao.updatedAt),
      },
      mensagens: msgs.map((m) => ({
        id: m.id,
        sessaoId: m.sessaoId,
        role: m.role,
        text: m.text,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      })),
    }
  }

  // ===========================================================================
  // RESOLUÇÃO DE AGENTE (projetosCaptados + projetoModelChain)
  // ===========================================================================

  private async resolverAgenteDoProjeto(projetoId: number): Promise<string> {
    const db = await this.getCoreDb()

    const [projeto] = await db
      .select({ agenteId: projetosCaptados.agenteId })
      .from(projetosCaptados)
      .where(eq(projetosCaptados.id, projetoId))
      .limit(1)

    if (projeto?.agenteId) {
      return String(projeto.agenteId)
    }

    this.logger.log(`Projeto ${projetoId} sem agente configurado → default: ${this.defaultAgentId}`)
    return this.defaultAgentId
  }

  private async obterCadeiaModelos(projetoId: number, fase: string): Promise<Array<{ modelo: string }>> {
    const db = await this.getCoreDb()

    const rows = await db
      .select({ modelo: projetoModelChain.modelo })
      .from(projetoModelChain)
      .where(eq(projetoModelChain.projetoId, projetoId))
      .orderBy(asc(projetoModelChain.posicao))

    if (rows.length > 0) {
      this.logger.log(`Cadeia para projeto ${projetoId} [${fase}]: ${rows.map(r => r.modelo).join(", ")}`)
      return rows
    }

    return [{ modelo: "biblioteca-global" }]
  }

  // ===========================================================================
  // DETECÇÃO + CRIAÇÃO DE TAREFA NO PROJETO (draft)
  // ===========================================================================

  private async detectarECriarTarefa(projetoId: number, textoUsuario: string): Promise<void> {
    if (textoUsuario.length < 10) return

    const solicitacoes = this.detectarSolicitacao(textoUsuario)
    if (solicitacoes.length === 0) return

    await this.criarTarefaDraft(projetoId, textoUsuario, solicitacoes[0]!)
  }

  private detectarSolicitacao(texto: string): string[] {
    const t = texto.toLowerCase()
    const chaves = [
      "não deve aparecer", "remova", "esconda", "oculte", "não mostre",
      "remover campo", "excluir campo", "apagar campo", "não quero", "não preciso",
      "tire o ", "coloque ", "adicionar ", "inclua ", "crie um ",
      "preciso de ", "quero que ", "deve aparecer", "aparecer na lista",
      "apenas na edição", "só na tela", "mude o ", "altere o ", "renomeie",
    ]
    const resultado: string[] = []
    for (const ch of chaves) {
      if (t.includes(ch) && !resultado.includes(texto.trim())) {
        resultado.push(texto.trim())
      }
    }
    return resultado
  }

  private async criarTarefaDraft(projetoId: number, textoOriginal: string, solicitacao: string): Promise<void> {
    try {
      const db = await this.factory.obter({ id: projetoId })
      const titulo = `[HelpDesk] ${solicitacao.substring(0, 100)}`
      await db.execute(
        sql`INSERT INTO tarefas (projeto_id, titulo, descricao, status, created_at, updated_at) VALUES (${projetoId}, ${titulo}, ${textoOriginal}, 'draft', NOW(), NOW())`,
      )
      this.logger.log(`Tarefa draft criada no projeto ${projetoId}: "${solicitacao.substring(0, 80)}..."`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Não foi possível criar tarefa no projeto ${projetoId}: ${msg}`)
    }
  }
}
