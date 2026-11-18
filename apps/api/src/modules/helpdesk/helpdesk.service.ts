/**
 * helpdesk.service.ts — Lógica de negócio do HelpDesk.
 *
 * Orquestra persistência (core db via ProjectDbFactory), resolução de agente
 * do projeto (projetosCaptados.agenteId + project_model_selection) e ponte com o
 * BFF OpenClaw (HelpDeskBridgeService).
 */
import { Injectable, Inject, Logger, Optional } from "@nestjs/common"
import { eq, desc, asc, and } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import * as coreSchema from "../../../../../database/schema"
import { agentes, projetosCaptados } from "../../../../../projects/gerenteagentes/schema"
import { HelpDeskBridgeService } from "./helpdesk.bridge"
import { RealtimeService } from "../realtime/realtime.service"
import { GerenteAgentesService } from "../../../../../projects/gerenteagentes/api/gerenteagentes.service"
import { TransbordoNotifier, type TransbordoResumo } from "../transbordo/transbordo.notifier"
import { TransbordoService } from "../transbordo/transbordo.service"

const { helpdeskSessoes: helpDeskSessionTable, helpdeskMensagens: helpDeskMessageTable, projetos: projectTable, usuarios: userTable } = coreSchema
/** O catálogo de agentes/modelos do GerenteAgentes vive em projeto_640. */
const GERENTE_AGENTES_PROJECT_ID = 640

@Injectable()
export class HelpDeskService {
  private readonly logger = new Logger(HelpDeskService.name)
  private readonly defaultAgentId = "biblioteca-global"

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    private readonly bridge: HelpDeskBridgeService,
    @Optional() private readonly gerenteAgentes?: GerenteAgentesService,
    @Optional() private readonly realtime?: RealtimeService,
    @Optional() private readonly transbordo?: TransbordoService,
    @Optional() private readonly transbordoNotifier?: TransbordoNotifier,
  ) {
    this.realtime?.setHelpDeskSnapshotProvider(async ({ sessionId, userId, projectId }) => {
      const history = await this.obterHistorico(sessionId, userId)
      if (history.sessao.usuarioId !== userId || history.sessao.projetoId !== projectId) return null
      return {
        sessaoId: sessionId,
        usuarioId: userId,
        projetoId: projectId,
        mensagens: history.mensagens,
      }
    })
  }

  private async getCoreDb(): Promise<CoreDb> {
    return this.coreDb
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
      .where(and(
        eq(helpDeskSessionTable.usuarioId, input.usuarioId),
        eq(helpDeskSessionTable.projetoId, input.projetoId),
      ))
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
  async obterSessaoAtiva(input: { usuarioId: number; projetoId: number }): Promise<
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
      .where(and(
        eq(helpDeskSessionTable.usuarioId, input.usuarioId),
        eq(helpDeskSessionTable.projetoId, input.projetoId),
      ))
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
    projetoId: number
  }): Promise<{ ok: boolean; messageId?: string; processing?: boolean; reason?: "offline" | "session_not_found" | "chat_closed"; retryable?: boolean }> {
    const db = await this.getCoreDb()

    const [sessao] = await db
      .select()
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.id, input.sessaoId))
      .limit(1)

    if (!sessao || sessao.status !== "active") {
      return { ok: false, reason: "session_not_found" }
    }

    if (sessao.usuarioId !== input.usuarioId || sessao.projetoId !== input.projetoId) {
      return { ok: false, reason: "session_not_found" }
    }

    if (await this.sessaoEmTransbordo(input.sessaoId)) {
      return { ok: false, reason: "chat_closed" }
    }

    // Persiste mensagem do usuário ANTES de enviar ao agente
    const [userMessage] = await db.insert(helpDeskMessageTable).values({
      sessaoId: input.sessaoId,
      role: "user",
      text: input.text.trim(),
    }).$returningId()
    if (userMessage) this.publicarMensagem(sessao.projetoId, input.usuarioId, input.sessaoId, userMessage.id, "user", input.text.trim())

    // Registra a solicitação antes de chamar o agente. O agente nunca deve
    // executar alterações diretamente; o motor recebe a solicitação em draft.
    const tarefa = await this.detectarECriarTarefa(sessao.projetoId, input.text.trim())

    if (!this.bridge.isConfigured()) {
      return { ok: false, reason: "offline" }
    }

    const agenteId = await this.resolverIdentificadorOpenClaw(sessao.agenteId)
    const modelChain = await this.obterCadeiaModelos(sessao.projetoId, "analysis")
    if (modelChain.length === 0) {
      return { ok: false, reason: "offline" }
    }

    // Resolve/cria sessão no BFF
    const resolved = await this.bridge.resolveSession({
      agenteId,
      usuarioId: input.usuarioId,
      projetoId: sessao.projetoId,
      model: modelChain[0]?.modelo,
    })

    // Fallback em cadeia de modelos
    const sendResult = await this.bridge.sendWithChain({
      sessionKey: resolved.sessionKey,
      text: input.text.trim(),
      modelChain,
    })

    if (sendResult.ok) {
      if (sendResult.processing) {
        this.realtime?.publicarHelpDesk({ projectId: sessao.projetoId, userId: input.usuarioId, sessionId: input.sessaoId, type: "helpdesk.processing.changed", payload: { processing: true, responded: false } })
        return { ok: true, messageId: sendResult.runId, processing: true }
      }
      const respostaAgente = this.confirmarTarefa(sendResult.responseText ?? "", tarefa)
      const [agentMessage] = await db.insert(helpDeskMessageTable).values({
        sessaoId: input.sessaoId,
        role: "agent",
        text: respostaAgente,
      }).$returningId()
      if (agentMessage) this.publicarMensagem(sessao.projetoId, input.usuarioId, input.sessaoId, agentMessage.id, "agent", respostaAgente)

      return { ok: true, messageId: sendResult.runId }
    }

    return { ok: false, reason: "offline", retryable: false }
  }

  /** Tool server-side: consulta tenant, destino e janela no fuso configurado. */
  async verificarTransbordoPossivel(input: { sessaoId: number; agora?: Date }) {
    const sessao = await this.obterSessaoPorId(input.sessaoId)
    if (!sessao || !this.transbordo) return { possivel: false, motivo: "sessao_nao_encontrada" as const }
    const tenant = await this.tenantDoProjeto(sessao.projetoId)
    if (!tenant) return { possivel: false, motivo: "tenant_nao_encontrado" as const }
    return this.transbordo.verificarPossivel({ tenantSlug: tenant, agora: input.agora })
  }

  /** Nome canônico da tool exposta ao catálogo de capacidades. */
  verificar_transbordo_possivel(input: { sessaoId: number; agora?: Date }) {
    return this.verificarTransbordoPossivel(input)
  }

  /** Tool server-side: grava a pausa antes de tentar qualquer notificação. */
  async transbordarParaHumano(input: { sessaoId: number; assunto: string; pendencia: string; coletado?: string[]; historicoUrl?: string; liberacaoUrl?: string }) {
    if (!this.transbordo || !this.transbordoNotifier) return { ok: false, reason: "indisponivel" as const }
    const sessao = await this.obterSessaoPorId(input.sessaoId)
    if (!sessao) return { ok: false, reason: "sessao_nao_encontrada" as const }
    const tenant = await this.tenantDoProjeto(sessao.projetoId)
    if (!tenant) return { ok: false, reason: "tenant_nao_encontrado" as const }
    const disponibilidade = await this.transbordo.verificarPossivel({ tenantSlug: tenant })
    if (!disponibilidade.possivel || !disponibilidade.config) return { ok: false, reason: disponibilidade.motivo ?? "indisponivel" }
    const historico = await this.obterHistorico(input.sessaoId, sessao.usuarioId, sessao.projetoId)
    const [usuario] = await this.coreDb.select({ nome: userTable.nome }).from(userTable).where(eq(userTable.id, sessao.usuarioId)).limit(1)
    const registro = await this.transbordo.criarRegistro({ tenantSlug: tenant, sessaoId: input.sessaoId })
    if (registro.jaExistente) return { ok: true, transbordoId: registro.id, pausado: true, jaExistente: true }
    const baseUrl = input.historicoUrl ?? `/helpdesk/${input.sessaoId}/history`
    const releaseUrl = input.liberacaoUrl ?? `/api/transbordo/liberar/${registro.tokenLiberacao}`
    const resumo: TransbordoResumo = {
      nome: usuario?.nome ?? "Cliente não identificado",
      assunto: input.assunto.trim() || historico.mensagens.find((m) => m.role === "user")?.text || "Não informado",
      coletado: input.coletado ?? historico.mensagens.filter((m) => m.role === "user").map((m) => m.text).slice(-10),
      pendencia: input.pendencia.trim() || "Aguardando atendimento humano",
      historicoUrl: baseUrl,
      liberacaoUrl: releaseUrl,
    }
    const [systemMessage] = await this.coreDb.insert(helpDeskMessageTable).values({ sessaoId: input.sessaoId, role: "system", text: "Seu atendimento foi encaminhado para um atendente humano. A agente ficará pausada até a liberação." }).$returningId()
    if (systemMessage) this.publicarMensagem(sessao.projetoId, sessao.usuarioId, input.sessaoId, systemMessage.id, "system", "Seu atendimento foi encaminhado para um atendente humano. A agente ficará pausada até a liberação.")
    const entrega = registro.tokenLiberacao ? await this.transbordoNotifier.enviar({ tipo: disponibilidade.config.destino.tipo, destino: disponibilidade.config.destino.valor, atendenteNome: disponibilidade.config.destino.nomeAtendente, resumo }) : { ok: false as const, reason: "send_failed" as const, detail: "transbordo já ativo" }
    await this.transbordo.registrarNotificacao({ id: registro.id, sucesso: entrega.ok, erro: entrega.ok ? undefined : entrega.reason })
    return { ok: true, transbordoId: registro.id, pausado: true, notificacao: entrega }
  }

  /** Nome canônico da tool exposta ao catálogo de capacidades. */
  transbordar_para_humano(input: { sessaoId: number; assunto: string; pendencia: string; coletado?: string[]; historicoUrl?: string; liberacaoUrl?: string }) {
    return this.transbordarParaHumano(input)
  }

  async liberarTransbordo(input: { sessaoId: number; tenantSlug: string; ator: string }): Promise<{ ok: boolean }> {
    if (!this.transbordo) return { ok: false }
    const result = await this.transbordo.liberarPorOperador(input)
    if (!result.ok) return result
    await this.inserirMensagemSistemica(input.sessaoId, `Atendimento liberado por ${input.ator}. A agente pode retomar a conversa.`)
    return result
  }

  async liberarTransbordoPorToken(token: string): Promise<{ ok: boolean }> {
    if (!this.transbordo) return { ok: false }
    const result = await this.transbordo.liberarPorTokenDetalhes(token)
    if (result.ok && result.sessaoId) await this.inserirMensagemSistemica(result.sessaoId, "Atendimento humano encerrado. A agente pode retomar a conversa.")
    return { ok: result.ok }
  }

  private async sessaoEmTransbordo(sessaoId: number): Promise<boolean> {
    const [row] = await this.coreDb.select({ id: coreSchema.transbordos.id }).from(coreSchema.transbordos).where(and(eq(coreSchema.transbordos.sessaoId, sessaoId), eq(coreSchema.transbordos.estado, "active"))).limit(1)
    return Boolean(row)
  }

  private async obterSessaoPorId(sessaoId: number) {
    const [row] = await this.coreDb.select().from(helpDeskSessionTable).where(eq(helpDeskSessionTable.id, sessaoId)).limit(1)
    return row
  }

  private async tenantDoProjeto(projetoId: number): Promise<string | undefined> {
    const [row] = await this.coreDb.select({ slug: projectTable.slug }).from(projectTable).where(eq(projectTable.id, projetoId)).limit(1)
    return row?.slug
  }

  private async inserirMensagemSistemica(sessaoId: number, text: string): Promise<void> {
    const [sessao] = await this.coreDb.select({ projetoId: helpDeskSessionTable.projetoId, usuarioId: helpDeskSessionTable.usuarioId }).from(helpDeskSessionTable).where(eq(helpDeskSessionTable.id, sessaoId)).limit(1)
    const [message] = await this.coreDb.insert(helpDeskMessageTable).values({ sessaoId, role: "system", text }).$returningId()
    if (sessao && message) this.publicarMensagem(sessao.projetoId, sessao.usuarioId, sessaoId, message.id, "system", text)
  }

  async consultarProcessamento(input: { sessaoId: number; usuarioId: number; projetoId: number }): Promise<{
    ok: true
    processing: boolean
    responded: boolean
  } | { ok: false; reason: "session_not_found" }> {
    const db = await this.getCoreDb()
    const [sessao] = await db
      .select()
      .from(helpDeskSessionTable)
      .where(eq(helpDeskSessionTable.id, input.sessaoId))
      .limit(1)

    if (!sessao || sessao.usuarioId !== input.usuarioId || sessao.projetoId !== input.projetoId) {
      return { ok: false, reason: "session_not_found" }
    }

    const [ultimaMensagem] = await db
      .select({ id: helpDeskMessageTable.id, text: helpDeskMessageTable.text })
      .from(helpDeskMessageTable)
      .where(and(
        eq(helpDeskMessageTable.sessaoId, input.sessaoId),
        eq(helpDeskMessageTable.role, "user"),
      ))
      .orderBy(desc(helpDeskMessageTable.id))
      .limit(1)

    if (!ultimaMensagem) return { ok: true, processing: false, responded: false }

    const agenteId = await this.resolverIdentificadorOpenClaw(sessao.agenteId)
    const resolved = await this.bridge.resolveSession({
      agenteId,
      usuarioId: input.usuarioId,
      projetoId: sessao.projetoId,
    })
    const resposta = await this.bridge.obterResposta(resolved.sessionKey, ultimaMensagem.text)

    if (resposta) {
      const [jaPersistida] = await db
        .select({ id: helpDeskMessageTable.id })
        .from(helpDeskMessageTable)
        .where(and(
          eq(helpDeskMessageTable.sessaoId, input.sessaoId),
          eq(helpDeskMessageTable.role, "agent"),
          eq(helpDeskMessageTable.text, resposta),
        ))
        .limit(1)

      if (!jaPersistida) {
        const [agentMessage] = await db.insert(helpDeskMessageTable).values({
          sessaoId: input.sessaoId,
          role: "agent",
          text: resposta,
        }).$returningId()
        if (agentMessage) this.publicarMensagem(sessao.projetoId, input.usuarioId, input.sessaoId, agentMessage.id, "agent", resposta)
      }
      this.realtime?.publicarHelpDesk({ projectId: sessao.projetoId, userId: input.usuarioId, sessionId: input.sessaoId, type: "helpdesk.processing.changed", payload: { processing: false, responded: true } })
      return { ok: true, processing: false, responded: true }
    }

    const processing = await this.bridge.sessaoEmProcessamento(resolved.sessionKey)
    this.realtime?.publicarHelpDesk({ projectId: sessao.projetoId, userId: input.usuarioId, sessionId: input.sessaoId, type: "helpdesk.processing.changed", payload: { processing, responded: false } })
    return {
      ok: true,
      processing,
      responded: false,
    }
  }

  private publicarMensagem(projetoId: number, usuarioId: number, sessaoId: number, id: number, role: "user" | "agent" | "system", text: string): void {
    this.realtime?.publicarHelpDesk({
      projectId: projetoId,
      userId: usuarioId,
      sessionId: sessaoId,
      type: "helpdesk.message.created",
      payload: { id, sessaoId, role, text, createdAt: new Date().toISOString() },
    })
  }

  // ===========================================================================
  // HISTÓRICO
  // ===========================================================================

  async obterHistorico(sessaoId: number, usuarioId: number, projetoId?: number): Promise<{
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

    if (!sessao || sessao.usuarioId !== usuarioId || (projetoId !== undefined && sessao.projetoId !== projetoId)) {
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
  // RESOLUÇÃO DE AGENTE (projetosCaptados + project_model_selection)
  // ===========================================================================

  private async obterProjetoCaptado(projetoId: number) {
    const catalogoDb = await this.factory.obter({ id: GERENTE_AGENTES_PROJECT_ID })
    const [projeto] = await catalogoDb
      .select({ id: projetosCaptados.id, slug: projetosCaptados.slug, agenteId: projetosCaptados.agenteId })
      .from(projetosCaptados)
      .where(eq(projetosCaptados.plataformaProjetoId, projetoId))
      .limit(1)
    return projeto
  }

  private async resolverAgenteDoProjeto(projetoId: number): Promise<string> {
    const projeto = await this.obterProjetoCaptado(projetoId)

    if (projeto?.agenteId) {
      return this.resolverIdentificadorOpenClaw(String(projeto.agenteId))
    }

    this.logger.log(`Projeto ${projetoId} sem agente configurado → default: ${this.defaultAgentId}`)
    return this.defaultAgentId
  }

  /** O catálogo usa o ID numérico; o console usa o identificador OpenClaw. */
  private async resolverIdentificadorOpenClaw(agenteId: string): Promise<string> {
    if (!/^\d+$/.test(agenteId)) return agenteId

    const catalogoDb = await this.factory.obter({ id: GERENTE_AGENTES_PROJECT_ID })
    const [agente] = await catalogoDb
      .select({ nome: agentes.nome })
      .from(agentes)
      .where(eq(agentes.id, Number(agenteId)))
      .limit(1)

    return agente?.nome ?? this.defaultAgentId
  }

  private async obterCadeiaModelos(projetoId: number, fase: string): Promise<Array<{ modelo: string }>> {
    const catalogoDb = await this.factory.obter({ id: GERENTE_AGENTES_PROJECT_ID })
    const projeto = await this.obterProjetoCaptado(projetoId)

    if (!projeto) return [{ modelo: "biblioteca-global" }]

    const tipo = fase === "analysis" ? "ANALYST" : fase.toUpperCase()
    const [result] = await catalogoDb.execute(sql`
      SELECT model AS modelo
        FROM project_model_selection
       WHERE project_slug = ${projeto.slug}
         AND tipo = ${tipo}
         AND enabled = 1
       ORDER BY ordem
    `)
    const rows = result as unknown as Array<{ modelo: string }>

    if (rows.length > 0) {
      this.logger.log(`Cadeia para projeto ${projetoId} [${fase}]: ${rows.map(r => r.modelo).join(", ")}`)
      return rows
    }

    return [{ modelo: "biblioteca-global" }]
  }

  // ===========================================================================
  // DETECÇÃO + CRIAÇÃO DE TAREFA NO PROJETO (draft)
  // ===========================================================================

  private async detectarECriarTarefa(projetoId: number, textoUsuario: string): Promise<{ id: number; externalId: string; status: string } | null> {
    const solicitacoes = this.detectarSolicitacao(textoUsuario)
    if (solicitacoes.length === 0) return null

    return this.criarTarefaDraft(projetoId, textoUsuario, solicitacoes[0]!)
  }

  private detectarSolicitacao(texto: string): string[] {
    const t = texto.toLowerCase()
    const perguntaInformativa = /^(como|qual|quais|o que|por que|porque|onde|quando|quem|posso|é possível|e possível|você pode|voce pode)\b/.test(t)
      || t.endsWith("?")
    if (perguntaInformativa) return []

    // Saudações e confirmações não são solicitações do motor.
    if (/^(oi|olá|ola|bom dia|boa tarde|boa noite|obrigado|obrigada|valeu|ok|certo|entendi)\b/.test(t)) {
      return []
    }

    const pedidoDeAlteracao = /\b(crie|criar|implemente|implementar|altere|alterar|corrija|corrigir|adicione|adicionar|remova|remover|mude|mudar|ajuste|ajustar|solicito|preciso que|quero que|gostaria que|faça|faca)\b/.test(t)
    return pedidoDeAlteracao && texto.trim() ? [texto.trim()] : []
  }

  private async criarTarefaDraft(projetoId: number, textoOriginal: string, solicitacao: string): Promise<{ id: number; externalId: string; status: string } | null> {
    try {
      const projetoCaptado = await this.obterProjetoCaptado(projetoId)
      if (!projetoCaptado) {
        this.logger.warn(`Não foi possível criar tarefa draft: projeto ${projetoId} não está cadastrado em projetos_captados`)
        return null
      }

      // `projetoId` é o ID do projeto da plataforma (ex.: TaQui = 6611),
      // enquanto tarefas e projetos_captados vivem no database do Gerente de
      // Agentes (projeto_640). Usar projetoId aqui tentava inserir em
      // projeto_6611, que não possui a tabela operacional `tarefas`.
      const titulo = `[HelpDesk] ${solicitacao.substring(0, 100)}`
      if (!this.gerenteAgentes) throw new Error("GerenteAgentes indisponível")
      const tarefa = await this.gerenteAgentes.criarTarefa(
        { id: projetoId, nome: "HelpDesk", slug: "helpdesk", perfil: "admin" },
        {
          managedProjectId: projetoCaptado.id,
          titulo,
          descricao: textoOriginal,
          tipo: "desenvolvimento",
          status: "draft",
          autoStart: false,
          ator: `helpdesk:${projetoId}`,
          databaseProjectId: GERENTE_AGENTES_PROJECT_ID,
        },
      ) as { id: number; externalId?: string; status?: string }
      this.logger.log(`Tarefa draft criada no projeto ${projetoId}: "${solicitacao.substring(0, 80)}..."`)
      return { id: Number(tarefa.id), externalId: tarefa.externalId ?? `task-${tarefa.id}`, status: tarefa.status ?? "draft" }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Não foi possível criar tarefa no projeto ${projetoId}: ${msg}`)
      return null
    }
  }

  private confirmarTarefa(resposta: string, tarefa: { id: number; externalId: string; status: string } | null): string {
    if (!tarefa) return resposta
    return `${resposta}\n\nSolicitação registrada como tarefa draft ${tarefa.externalId} (id ${tarefa.id}). Estado atual: ${tarefa.status}. Você pode perguntar por esse identificador para acompanhar o andamento.`
  }
}
