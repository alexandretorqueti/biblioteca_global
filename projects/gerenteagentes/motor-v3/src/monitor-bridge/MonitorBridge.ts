/**
 * MonitorBridge — integração com Monitor para erros não catalogados (B01)
 * 
 * F4: Monitor Bridge
 * - Detecta erros que não casam com nenhum pattern do catálogo
 * - Invoca Monitor (modelo caro) para análise
 * - Monitor propõe novas entradas no catálogo (Casos A/B/C)
 * - Trava D4: Monitor auto-ativa apenas Caso A (variação de evento existente)
 * - Casos B e C requerem aprovação humana
 * 
 * Casos:
 * - A: Variação de evento existente (ex: novo pattern para E01_CONTEXT_OVERFLOW)
 *      → INSERT real em motor_patterns com active=1 (auto_activated),
 *        recarrega catálogo para a próxima ocorrência casar.
 *        Se faltar eventId/pattern válido, rebaixa para Caso B (nunca cria
 *        evento no Caso A).
 * - B: Evento completamente novo
 *      → INSERT real em motor_events/motor_patterns/motor_reactions com
 *        active=0; a proposta pending_review fica vinculada ao evento via
 *        event_id. Nada entra em classificação enquanto active=0
 *        (CatalogLoader.reload filtra active=1).
 * - C: Monitor não consegue resolver
 *      → Notifica humano via MonitorHumanNotifier (chat da tarefa, decisão da
 *        tarefa 1043 — não Telegram), aguarda intervenção.
 * 
 * APROVAÇÃO/REJEIÇÃO PERSISTENTES:
 * - approveProposal: UPDATE active=1 em event+patterns+reactions (flag, NUNCA
 *   DELETE físico — princípio de versionamento do catálogo) + CatalogLoader
 *   .reload() (hot reload, sem restart) + status approved.
 * - rejectProposal: mantém active=0, status rejected com review_notes.
 * 
 * HIDRATAÇÃO PÓS-RESTART:
 * - hydrateProposals() carrega as propostas pending_review de
 *   motor_catalog_proposals no boot e repopula o Map em memória pela chave
 *   proposal_json.id; approve/reject tentam hidratar do banco quando o id não
 *   está no Map (a API HTTP sobrevive a redeploy).
 * 
 * PROPAGAÇÃO:
 * - Falha de escrita no catálogo (insert/update) NÃO é engolida: propaga por
 *   handleUncataloguedError até o GovernedFailureHandler, que registra
 *   outcome 'failed' e roda o fallback legado.
 */

import type { MessageBus } from '../bus/index.js'
import type { CatalogLoader } from '../catalog/index.js'
import type { EventClassifier } from '../classifier/index.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { MonitorHumanNotifier, MonitorHumanNotifyInput } from '../monitor/HumanNotifier.js'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

export interface MonitorBridgeConfig {
  monitorModel: string // Modelo caro para Monitor (ex: gpt-6.1-sol)
  /** Relíquia de compat: a notificação humana real usa o chat da tarefa (MonitorHumanNotifier). Não implementar cliente Telegram. */
  telegramTarget: string
  autoActivateCaseA: boolean // Auto-ativar Caso A (D4)
  monitorInvoker?: MonitorInvoker
  db?: MySql2Database<typeof schema>
  /** Notificador humano real (Caso C) — TaskChatHumanNotifier em produção. */
  humanNotifier?: MonitorHumanNotifier
}

export interface MonitorInvoker {
  invoke(input: { model: string; prompt: string; context: PrimitiveContext }): Promise<Partial<MonitorProposal>>
}

export interface MonitorProposal {
  id: string
  case: 'A' | 'B' | 'C'
  error: {
    code?: string
    message?: string
    stack?: string
  }
  proposal: {
    eventId?: number // Caso A: evento existente
    newPattern?: {
      pattern: string
      matchType: 'regex' | 'contains' | 'exact'
      matchTarget: 'code' | 'message' | 'stack' | 'action_result'
    }
    newEvent?: {
      code: string
      name: string
      category: 'erro' | 'verificacao' | 'conclusao' | 'estado' | 'humano' | 'infra'
      patterns: Array<{
        pattern: string
        matchType: 'regex' | 'contains' | 'exact'
        matchTarget: 'code' | 'message' | 'stack' | 'action_result'
      }>
      reactions: Array<{
        occurrence: number
        actionCode: string
        params?: Record<string, any>
      }>
    }
  }
  diagnosis: string
  taskId: string
  subtaskId?: number
  status: 'pending' | 'approved' | 'rejected' | 'auto_activated'
  createdAt: Date
  reviewedAt?: Date
  reviewedBy?: string
}

const EVENT_CATEGORIES = new Set(['erro', 'verificacao', 'conclusao', 'estado', 'humano', 'infra'])
const MATCH_TYPES = new Set(['regex', 'contains', 'exact'])
const MATCH_TARGETS = new Set(['code', 'message', 'stack', 'action_result'])

export class MonitorBridge {
  private config: MonitorBridgeConfig
  private bus: MessageBus
  private loader: CatalogLoader
  private classifier: EventClassifier
  private proposals = new Map<string, MonitorProposal>()
  private proposalCounter = 0

  constructor(
    bus: MessageBus,
    loader: CatalogLoader,
    classifier: EventClassifier,
    config: Partial<MonitorBridgeConfig> = {}
  ) {
    this.bus = bus
    this.loader = loader
    this.classifier = classifier
    this.config = {
      monitorModel: config.monitorModel ?? 'gpt-6.1-sol',
      telegramTarget: config.telegramTarget ?? '7147090795',
      autoActivateCaseA: config.autoActivateCaseA ?? true,
      monitorInvoker: config.monitorInvoker,
      db: config.db,
      humanNotifier: config.humanNotifier,
    }
  }

  /**
   * Analisa erro não catalogado e propõe solução via Monitor
   */
  async handleUncataloguedError(
    context: PrimitiveContext,
    error: { code?: string; message?: string; stack?: string; actionResult?: string },
    alreadyClassifiedAsUncatalogued = false,
  ): Promise<{ proposalId: string; case: 'A' | 'B' | 'C' }> {
    // 1. Classifica erro (retorna null se não catalogado)
    const classification = alreadyClassifiedAsUncatalogued ? null : await this.classifier.classify(
      context.taskId,
      context.subtaskId ?? null,
      context.generation,
      error,
    )

    if (classification !== null) {
      // Erro já catalogado, não precisa do Monitor
      throw new Error('Erro já catalogado, não requer Monitor')
    }

    // 2. Invoca Monitor (consoleInvoker)
    const proposal = await this.invokeMonitor(context, error)

    // 3. Processa proposta conforme caso (A/B/C) — falhas de escrita no
    //    catálogo PROPAGAM (sem try/catch engolidor) até o
    //    GovernedFailureHandler (outcome 'failed' + fallback legado).
    const proposalId = await this.processProposal(proposal)

    return { proposalId, case: proposal.case }
  }

  /** Invoca o Monitor configurado; na ausência dele cria apenas proposta segura. */
  private async invokeMonitor(
    context: PrimitiveContext,
    error: { code?: string; message?: string; stack?: string; actionResult?: string }
  ): Promise<MonitorProposal> {
    const proposalId = `proposal-${++this.proposalCounter}-${Date.now()}`
    const safeProposal: MonitorProposal = {
      id: proposalId,
      case: 'B',
      error,
      proposal: {
        newEvent: {
          code: `E${Date.now()}_UNKNOWN`,
          name: 'Erro Desconhecido',
          category: 'erro',
          patterns: [
            {
              pattern: error.message?.substring(0, 50) ?? 'unknown',
              matchType: 'contains',
              matchTarget: 'message',
            },
          ],
          reactions: [
            {
              occurrence: 1,
              actionCode: 'A01_SANITIZE',
            },
          ],
        },
      },
      diagnosis: 'Erro não catalogado, requer análise do Monitor',
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      status: 'pending',
      createdAt: new Date(),
    }
    const invoker = this.config.monitorInvoker ?? this.consoleInvoker(context)
    if (!invoker) return safeProposal

    try {
      const answer = await invoker.invoke({
        model: this.config.monitorModel,
        context,
        prompt: this.monitorPrompt(context, error),
      })
      return {
        ...safeProposal,
        ...answer,
        id: answer.id ?? proposalId,
        error,
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        status: answer.status ?? 'pending',
        createdAt: answer.createdAt ?? new Date(),
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { ...safeProposal, diagnosis: `${safeProposal.diagnosis}; Monitor indisponível: ${message.slice(0, 300)}` }
    }
  }

  private monitorPrompt(context: PrimitiveContext, error: Record<string, unknown>): string {
    return [
      'Você é o Monitor do Motor v3. Responda SOMENTE JSON válido.',
      'A proposta nunca executa código; casos B/C permanecem pendentes de revisão humana.',
      'Formato: {"case":"A|B|C","diagnosis":"...","proposal":{...}}',
      `context=${JSON.stringify({ taskId: context.taskId, subtaskId: context.subtaskId, generation: context.generation })}`,
      `error=${JSON.stringify(error)}`,
    ].join('\n')
  }

  private consoleInvoker(context: PrimitiveContext): MonitorInvoker | undefined {
    const consoleApi = context.consoleApi
    if (!consoleApi || typeof consoleApi.createSession !== 'function' || typeof consoleApi.sendMessage !== 'function' || typeof consoleApi.getSessionStatus !== 'function') return undefined
    return {
      invoke: async ({ model, prompt }) => {
        const session = await consoleApi.createSession({
          key: `monitor-${context.taskId}-${Date.now()}`,
          agentId: context.agentId,
          model,
          metadata: { taskId: context.taskId, executionId: context.executionId, phase: 'monitor_catalog_proposal' },
        })
        await consoleApi.sendMessage({ session, message: prompt })
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const status = await consoleApi.getSessionStatus(session)
          if (status.isFailed) throw new Error(status.error ?? 'Monitor session failed')
          if (status.isComplete && status.lastResponse) return this.parseMonitorResponse(status.lastResponse)
          await new Promise(resolve => setTimeout(resolve, 1_000))
        }
        throw new Error('Monitor session timeout')
      },
    }
  }

  private parseMonitorResponse(response: string): Partial<MonitorProposal> {
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? response
    const parsed = JSON.parse(fenced) as Partial<MonitorProposal>
    if (parsed.case !== 'A' && parsed.case !== 'B' && parsed.case !== 'C') throw new Error('Monitor response has invalid case')
    if (!parsed.proposal || typeof parsed.proposal !== 'object') throw new Error('Monitor response has no proposal')
    return parsed
  }

  // ============================================================
  // Processamento por caso — escrita real no catálogo
  // ============================================================

  /**
   * Processa proposta conforme caso (A/B/C).
   * Falhas de INSERT/UPDATE no catálogo propagam (ver cabeçalho).
   */
  private async processProposal(proposal: MonitorProposal): Promise<string> {
    const proposalId = proposal.id

    switch (proposal.case) {
      case 'A': {
        // Caso A: Variação de evento existente (D4: auto-ativa pattern)
        if (this.config.autoActivateCaseA && this.isCaseAValid(proposal)) {
          proposal.status = 'auto_activated'
          await this.insertCaseAPattern(proposal)
          // Hot reload: a PRÓXIMA ocorrência deve casar com o novo pattern.
          await this.reloadCatalogSafe(proposal)
        } else if (!this.isCaseAValid(proposal)) {
          // Evento/pattern ausente ou inválido → REBAIXA para Caso B
          // (nunca criar evento no Caso A).
          proposal.case = 'B'
          proposal.proposal.newPattern = undefined
          proposal.proposal.newEvent = this.newEventFromDowngrade(proposal)
          proposal.status = 'pending'
          await this.insertCaseBCatalog(proposal)
        } else {
          // autoActivateCaseA=false: aguarda revisão humana
          proposal.status = 'pending'
        }
        await this.bus.send({
          type: 'CATALOG_ENTRY_AUTO_ACTIVATED',
          taskId: proposal.taskId,
          subtaskId: proposal.subtaskId,
          executionId: `proposal-${proposalId}`,
          payload: { proposalId, case: proposal.case },
          timestamp: new Date().toISOString(),
        })
        break
      }

      case 'B': {
        // Caso B: Evento completamente novo — INSERT com active=0
        proposal.status = 'pending'
        await this.insertCaseBCatalog(proposal)
        await this.bus.send({
          type: 'CATALOG_ENTRY_PROPOSED',
          taskId: proposal.taskId,
          subtaskId: proposal.subtaskId,
          executionId: `proposal-${proposalId}`,
          payload: { proposalId, case: 'B' },
          timestamp: new Date().toISOString(),
        })
        break
      }

      case 'C': {
        // Caso C: Monitor não consegue resolver — notificação humana real
        proposal.status = 'pending'
        await this.notifyHuman(proposal)
        await this.bus.send({
          type: 'MONITOR_UNABLE_TO_RESOLVE',
          taskId: proposal.taskId,
          subtaskId: proposal.subtaskId,
          executionId: `proposal-${proposalId}`,
          payload: { proposalId, case: 'C' },
          timestamp: new Date().toISOString(),
        })
        break
      }
    }

    this.proposals.set(proposalId, proposal)
    await this.persistProposal(proposal)
    return proposalId
  }

  /** Caso A válido: eventId numérico válido + pattern não vazio + enums válidos. */
  private isCaseAValid(proposal: MonitorProposal): boolean {
    const eventId = proposal.proposal.eventId
    const newPattern = proposal.proposal.newPattern
    if (!newPattern) return false
    if (eventId == null || !Number.isInteger(eventId) || eventId <= 0) return false
    if (typeof newPattern.pattern !== 'string' || newPattern.pattern.trim() === '') return false
    return MATCH_TYPES.has(newPattern.matchType) && MATCH_TARGETS.has(newPattern.matchTarget)
  }

  /**
   * CASO A: INSERT real em motor_patterns com active=1 (auto_activated).
   * A proposta pendente guarda o vínculo via eventId (persistProposal grava
   * event_id na linha de motor_catalog_proposals).
   */
  private async insertCaseAPattern(proposal: MonitorProposal): Promise<void> {
    if (!this.config.db) return
    const newPattern = proposal.proposal.newPattern!
    await (this.config.db as any).insert(schema.motorPatterns).values({
      eventId: proposal.proposal.eventId,
      pattern: newPattern.pattern,
      matchType: newPattern.matchType,
      matchTarget: newPattern.matchTarget,
      active: 1,
    })
  }

  /**
   * CASO B: INSERT real em motor_events(active=0) + motor_patterns(active=0)
   * + motor_reactions(active=0). actionCode é resolvido para action_id via
   * SELECT em motor_actions (somente leitura) — código inexistente falha
   * visivelmente, nunca cria linha órfã. O id do evento é devolvido para
   * vincular à proposta (event_id) junto do persistProposal.
   */
  private async insertCaseBCatalog(proposal: MonitorProposal): Promise<number | null> {
    if (!this.config.db) return null
    const db = this.config.db as any
    const newEvent = proposal.proposal.newEvent
    if (!newEvent) throw new Error('Caso B sem proposal.newEvent — impossível materializar evento')

    const [eventInsert] = await db.insert(schema.motorEvents).values({
      code: String(newEvent.code).slice(0, 100),
      name: String(newEvent.name || newEvent.code).slice(0, 255),
      category: EVENT_CATEGORIES.has(newEvent.category) ? newEvent.category : 'erro',
      scope: 'subtarefa',
      priority: 100,
      active: 0,
    })
    const eventId = Number(eventInsert?.insertId ?? 0)
    if (!Number.isInteger(eventId) || eventId <= 0) {
      throw new Error('INSERT em motor_events não retornou id — verifique o driver')
    }

    for (const p of newEvent.patterns ?? []) {
      if (typeof p.pattern !== 'string' || p.pattern.trim() === '') continue
      await db.insert(schema.motorPatterns).values({
        eventId,
        pattern: p.pattern,
        matchType: MATCH_TYPES.has(p.matchType) ? p.matchType : 'contains',
        matchTarget: MATCH_TARGETS.has(p.matchTarget) ? p.matchTarget : 'message',
        active: 0,
      })
    }

    for (const r of newEvent.reactions ?? []) {
      const actionId = await this.resolveActionId(r.actionCode)
      await db.insert(schema.motorReactions).values({
        eventId,
        occurrence: Number.isInteger(r.occurrence) ? r.occurrence : 1,
        actionId,
        paramsJson: r.params ?? null,
        version: 1,
        active: 0,
      })
    }

    // Vincula o evento criado à proposta (event_id) para approve/reject
    // pós-restart saberem o que ativar.
    proposal.proposal.eventId = eventId
    return eventId
  }

  /** Resolve actionCode → action_id em motor_actions (somente leitura). */
  private async resolveActionId(actionCode: string): Promise<number> {
    const db = this.config.db as any
    const rows = await db.select({ id: schema.motorActions.id, code: schema.motorActions.code })
      .from(schema.motorActions)
      .where(sql`${schema.motorActions.code} = ${actionCode} AND ${schema.motorActions.active} = 1 LIMIT 1`)
    const actionId = Number(rows?.[0]?.id ?? 0)
    if (!Number.isInteger(actionId) || actionId <= 0) {
      // Código inexistente: falha visível (propaga até GovernedFailureHandler),
      // nunca cria reação órfã.
      throw new Error(`Código de ação '${actionCode}' não encontrado em motor_actions (active=1)`)
    }
    return actionId
  }

  /** Rebaixamento Caso A → B: monta newEvent a partir do pattern rejeitado. */
  private newEventFromDowngrade(proposal: MonitorProposal): NonNullable<MonitorProposal['proposal']['newEvent']> {
    const base = proposal.proposal.newEvent
    if (base?.code) return base
    const fallbackPattern = proposal.proposal.newPattern?.pattern
      ?? proposal.error.message?.substring(0, 50)
      ?? 'unknown'
    return {
      code: `E${Date.now()}_DOWNGRADE`,
      name: 'Erro Desconhecido (rebaixado do Caso A)',
      category: 'erro',
      patterns: [{ pattern: String(fallbackPattern), matchType: 'contains', matchTarget: 'message' }],
      reactions: [{ occurrence: 1, actionCode: 'A01_SANITIZE' }],
    }
  }

  /**
   * Persiste a proposta em motor_catalog_proposals (status normalizado) e
   * vincula o event_id quando houver.
   */
  private async persistProposal(proposal: MonitorProposal): Promise<void> {
    if (!this.config.db) return
    const db = this.config.db as any
    const dbStatus = proposal.status === 'auto_activated' ? 'auto_activated' : 'pending_review'
    const [insert] = await db.insert(schema.motorCatalogProposals).values({
      source: 'monitor',
      status: dbStatus,
      eventId: proposal.proposal.eventId ?? null,
      diagnosis: proposal.diagnosis,
      proposalJson: proposal,
      tarefaId: proposal.taskId,
      subtarefaId: proposal.subtaskId ?? null,
    })
    const rowId = Number(insert?.insertId ?? 0)
    if (rowId > 0 && proposal.proposal.eventId) {
      // Garante o vínculo event_id na proposta (idempotente).
      await db.update(schema.motorCatalogProposals)
        .set({ eventId: proposal.proposal.eventId })
        .where(sql`${schema.motorCatalogProposals.id} = ${rowId}`)
    }
  }

  // ============================================================
  // Aprovação/rejeição persistentes
  // ============================================================

  /**
   * Aprova proposta (humano via API): ativa event+patterns+reactions
   * (active=1 via flag — NUNCA DELETE) e recarrega o catálogo (hot reload,
   * sem restart). Se o id não está no Map, tenta hidratar do banco
   * (sobrevive a redeploy).
   */
  async approveProposal(proposalId: string, reviewedBy: string): Promise<void> {
    const proposal = this.proposals.get(proposalId) ?? await this.hydrateProposalById(proposalId)
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    proposal.status = 'approved'
    proposal.reviewedAt = new Date()
    proposal.reviewedBy = reviewedBy
    await this.activateCatalogForProposal(proposal)
    await this.persistReview(proposal)

    await this.bus.send({
      type: 'CATALOG_ENTRY_APPROVED',
      taskId: proposal.taskId,
      subtaskId: proposal.subtaskId,
      executionId: `proposal-${proposalId}`,
      payload: { proposalId, reviewedBy },
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Rejeita proposta (humano via API): mantém event+patterns+reactions
   * com active=0 (compensação por flag, sem DELETE físico) e grava
   * status rejected com review_notes. Se o id não está no Map, tenta
   * hidratar do banco.
   */
  async rejectProposal(proposalId: string, reviewedBy: string, reason?: string): Promise<void> {
    const proposal = this.proposals.get(proposalId) ?? await this.hydrateProposalById(proposalId)
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    proposal.status = 'rejected'
    proposal.reviewedAt = new Date()
    proposal.reviewedBy = reviewedBy
    await this.persistReview(proposal, reason)
    // Mantém active=0: nada a desativar (Caso B nunca ativou; Caso A não
    // rejeitável em auto_activated). Nada entra em classificação.

    await this.bus.send({
      type: 'CATALOG_ENTRY_REJECTED',
      taskId: proposal.taskId,
      subtaskId: proposal.subtaskId,
      executionId: `proposal-${proposalId}`,
      payload: { proposalId, reviewedBy, reason },
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Ativa event+patterns+reactions (active=1) da proposta e recarrega o
   * catálogo (hot reload sem restart). Sem db: apenas recarrega o cache.
   */
  private async activateCatalogForProposal(proposal: MonitorProposal): Promise<void> {
    if (this.config.db && proposal.proposal.eventId) {
      const db = this.config.db as any
      const eventId = proposal.proposal.eventId
      await db.update(schema.motorEvents).set({ active: 1 }).where(sql`${schema.motorEvents.id} = ${eventId}`)
      await db.update(schema.motorPatterns).set({ active: 1 }).where(sql`${schema.motorPatterns.eventId} = ${eventId}`)
      await db.update(schema.motorReactions).set({ active: 1 }).where(sql`${schema.motorReactions.eventId} = ${eventId}`)
    }
    await this.reloadCatalogSafe(proposal)
  }

  /** Recarrega o catálogo sem derrubar o fluxo de aprovação em cache puro. */
  private async reloadCatalogSafe(proposal: MonitorProposal): Promise<void> {
    try {
      await this.loader.reload()
    } catch (error) {
      // Em produção o reload é barato (selects com cache); se quebrar em
      // modo memória pura (testes sem db), o estado do Map já é a fonte.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[MonitorBridge] reload do catálogo falhou para proposal ${proposal.id}: ${message.slice(0, 300)}`)
    }
  }

  private async persistReview(proposal: MonitorProposal, reason?: string): Promise<void> {
    if (!this.config.db) return
    await (this.config.db as any).update(schema.motorCatalogProposals)
      .set({ status: proposal.status, reviewedBy: proposal.reviewedBy, reviewNotes: reason ?? null, updatedAt: new Date() })
      .where(sql`JSON_UNQUOTE(JSON_EXTRACT(proposal_json, '$.id')) = ${proposal.id}`)
  }

  // ============================================================
  // Hidratação pós-restart
  // ============================================================

  /**
   * Hidrata as propostas pendentes de motor_catalog_proposals (boot):
   * reconstrói MonitorProposal a partir de proposal_json e repopula o Map
   * em memória pela chave proposal_json.id. Sem db: no-op (modo memória).
   */
  async hydrateProposals(): Promise<number> {
    if (!this.config.db) return 0
    const db = this.config.db as any
    const rows = await db.select().from(schema.motorCatalogProposals)
      .where(sql`${schema.motorCatalogProposals.status} = 'pending_review'`)
    let hydrated = 0
    for (const row of rows ?? []) {
      const proposal = this.toProposal(row)
      if (proposal && !this.proposals.has(proposal.id)) {
        this.proposals.set(proposal.id, proposal)
        hydrated++
      }
    }
    if (hydrated > 0) {
      console.log(`[MonitorBridge] Hidratadas ${hydrated} proposta(s) pendente(s) do banco`)
    }
    return hydrated
  }

  /** Busca/repõe UMA proposta no Map a partir do banco (qualquer status). */
  private async hydrateProposalById(proposalId: string): Promise<MonitorProposal | undefined> {
    if (!this.config.db) return undefined
    const db = this.config.db as any
    const rows = await db.select().from(schema.motorCatalogProposals)
      .where(sql`JSON_UNQUOTE(JSON_EXTRACT(proposal_json, '$.id')) = ${proposalId} LIMIT 1`)
    const row = rows?.[0]
    if (!row) return undefined
    const proposal = this.toProposal(row)
    if (!proposal) return undefined
    this.proposals.set(proposal.id, proposal)
    return proposal
  }

  private toProposal(row: any): MonitorProposal | undefined {
    try {
      const raw = row?.proposalJson
      const json: any = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!json || typeof json.id !== 'string' || !json.proposal || typeof json.proposal !== 'object') return undefined
      return {
        ...json,
        id: json.id,
        createdAt: json.createdAt ? new Date(json.createdAt) : new Date(row?.createdAt ?? Date.now()),
      } as MonitorProposal
    } catch {
      return undefined
    }
  }

  // ============================================================
  // Notificação humana (Caso C)
  // ============================================================

  /**
   * Notifica humano (Caso C): usa o MonitorHumanNotifier injetado (chat da
   * tarefa — decisão da tarefa 1043; telegramTarget é relíquia de compat).
   * Deduplicação por marcador estável fica no notifier (monitorNotifyMarker).
   * console.log permanece como eco diagnóstico secundário.
   */
  private async notifyHuman(proposal: MonitorProposal): Promise<void> {
    const summary = [
      `Caso C (Monitor não resolveu): ${proposal.diagnosis}`,
      `erro: ${proposal.error?.message ?? proposal.error?.code ?? 'sem detalhe'}`.trim(),
    ].join(' | ').slice(0, 1500)

    // Eco diagnóstico secundário (melhor esforço; nunca derruba o fluxo).
    console.log(`[MonitorBridge] Notificando humano sobre proposal ${proposal.id}`)
    console.log(`  Target (relíquia compat): ${this.config.telegramTarget}`)
    console.log(`  Diagnosis: ${proposal.diagnosis}`)

    const notifier = this.config.humanNotifier
    if (!notifier) return
    const input: MonitorHumanNotifyInput = {
      taskId: proposal.taskId,
      blockReason: 'monitor_catalogo_caso_c',
      summary,
    }
    try {
      await notifier.notify(input)
    } catch (error) {
      // Falha de notificação é melhor esforço (tarefa segue bloqueada e
      // visível); eco diagnóstico para auditoria.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[MonitorBridge] Falha ao notificar humano (proposal ${proposal.id}): ${message.slice(0, 300)}`)
    }
  }

  /**
   * Lista propostas pendentes
   */
  getPendingProposals(): MonitorProposal[] {
    return Array.from(this.proposals.values()).filter(p => p.status === 'pending')
  }

  /**
   * Busca proposta por ID
   */
  getProposal(proposalId: string): MonitorProposal | undefined {
    return this.proposals.get(proposalId)
  }
}
