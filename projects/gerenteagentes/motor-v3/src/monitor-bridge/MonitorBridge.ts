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
 *      → Auto-ativa pattern conservador, log pendente revisão
 * - B: Evento completamente novo
 *      → Cria proposta com active=0, aguarda aprovação humana
 * - C: Monitor não consegue resolver
 *      → Notifica humano via Telegram, aguarda intervenção
 */

import type { MessageBus } from '../bus/index.js'
import type { CatalogLoader } from '../catalog/index.js'
import type { EventClassifier } from '../classifier/index.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

export interface MonitorBridgeConfig {
  monitorModel: string // Modelo caro para Monitor (ex: gpt-5.6-sol)
  telegramTarget: string // Target para notificações (ex: 7147090795)
  autoActivateCaseA: boolean // Auto-ativar Caso A (D4)
  monitorInvoker?: MonitorInvoker
  db?: MySql2Database<typeof schema>
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
      monitorModel: config.monitorModel ?? 'gpt-5.6-sol',
      telegramTarget: config.telegramTarget ?? '7147090795',
      autoActivateCaseA: config.autoActivateCaseA ?? true,
      monitorInvoker: config.monitorInvoker,
      db: config.db,
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

    // 2. Invoca Monitor (TODO: implementação real com LLM)
    const proposal = await this.invokeMonitor(context, error)

    // 3. Processa proposta conforme caso (A/B/C)
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

  /**
   * Processa proposta conforme caso (A/B/C)
   */
  private async processProposal(proposal: MonitorProposal): Promise<string> {
    const proposalId = proposal.id

    switch (proposal.case) {
      case 'A':
        // Caso A: Variação de evento existente
        if (this.config.autoActivateCaseA && proposal.proposal.newPattern) {
          // Auto-ativa pattern conservador
          proposal.status = 'auto_activated'
          
          // TODO: Implementar insert real no banco
          // await db.insert(motorPatterns).values({ ... })
          
          // Emite evento no bus
          await this.bus.send({
            type: 'CATALOG_ENTRY_AUTO_ACTIVATED',
            taskId: proposal.taskId,
            subtaskId: proposal.subtaskId,
            executionId: `proposal-${proposalId}`,
            payload: { proposalId, case: 'A' },
            timestamp: new Date().toISOString(),
          })
        } else {
          // Não auto-ativa, aguarda revisão
          proposal.status = 'pending'
        }
        break

      case 'B':
        // Caso B: Evento completamente novo
        proposal.status = 'pending'
        
        // TODO: Implementar insert real no banco com active=0
        // await db.insert(motorEvents).values({ ..., active: 0 })
        
        // Emite evento no bus
        await this.bus.send({
          type: 'CATALOG_ENTRY_PROPOSED',
          taskId: proposal.taskId,
          subtaskId: proposal.subtaskId,
          executionId: `proposal-${proposalId}`,
          payload: { proposalId, case: 'B' },
          timestamp: new Date().toISOString(),
        })
        break

      case 'C':
        // Caso C: Monitor não consegue resolver
        proposal.status = 'pending'
        
        // Notifica humano via Telegram
        await this.notifyHuman(proposal)
        
        // Emite evento no bus
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

    this.proposals.set(proposalId, proposal)
    await this.persistProposal(proposal)
    return proposalId
  }

  private async persistProposal(proposal: MonitorProposal): Promise<void> {
    if (!this.config.db) return
    await (this.config.db as any).insert(schema.motorCatalogProposals).values({
      source: 'monitor',
      status: proposal.status === 'auto_activated' ? 'auto_activated' : 'pending_review',
      eventId: proposal.proposal.eventId ?? null,
      diagnosis: proposal.diagnosis,
      proposalJson: proposal,
      tarefaId: proposal.taskId,
      subtarefaId: proposal.subtaskId ?? null,
    })
  }

  /**
   * Aprova proposta (humano via API)
   */
  async approveProposal(proposalId: string, reviewedBy: string): Promise<void> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    proposal.status = 'approved'
    proposal.reviewedAt = new Date()
    proposal.reviewedBy = reviewedBy
    await this.persistReview(proposal)

    // TODO: Implementar update real no banco (active=1)
    // await db.update(motorEvents).set({ active: 1 }).where(...)

    // Emite evento no bus
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
   * Rejeita proposta (humano via API)
   */
  async rejectProposal(proposalId: string, reviewedBy: string, reason?: string): Promise<void> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    proposal.status = 'rejected'
    proposal.reviewedAt = new Date()
    proposal.reviewedBy = reviewedBy
    await this.persistReview(proposal, reason)

    // TODO: Implementar delete real no banco
    // await db.delete(motorEvents).where(...)

    // Emite evento no bus
    await this.bus.send({
      type: 'CATALOG_ENTRY_REJECTED',
      taskId: proposal.taskId,
      subtaskId: proposal.subtaskId,
      executionId: `proposal-${proposalId}`,
      payload: { proposalId, reviewedBy, reason },
      timestamp: new Date().toISOString(),
    })
  }

  private async persistReview(proposal: MonitorProposal, reason?: string): Promise<void> {
    if (!this.config.db) return
    await (this.config.db as any).update(schema.motorCatalogProposals)
      .set({ status: proposal.status, reviewedBy: proposal.reviewedBy, reviewNotes: reason ?? null, updatedAt: new Date() })
      .where(sql`JSON_UNQUOTE(JSON_EXTRACT(proposal_json, '$.id')) = ${proposal.id}`)
  }

  /**
   * Notifica humano via Telegram (TODO: implementação real)
   */
  private async notifyHuman(proposal: MonitorProposal): Promise<void> {
    // TODO: Implementar chamada real ao Telegram API
    // Por enquanto, apenas loga
    
    console.log(`[MonitorBridge] Notificando humano sobre proposal ${proposal.id}`)
    console.log(`  Target: ${this.config.telegramTarget}`)
    console.log(`  Diagnosis: ${proposal.diagnosis}`)
    console.log(`  Error: ${JSON.stringify(proposal.error)}`)
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
