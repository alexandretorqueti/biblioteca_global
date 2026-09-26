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

export interface MonitorBridgeConfig {
  monitorModel: string // Modelo caro para Monitor (ex: gpt-5.6-sol)
  telegramTarget: string // Target para notificações (ex: 7147090795)
  autoActivateCaseA: boolean // Auto-ativar Caso A (D4)
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
    }
  }

  /**
   * Analisa erro não catalogado e propõe solução via Monitor
   */
  async handleUncataloguedError(
    context: PrimitiveContext,
    error: { code?: string; message?: string; stack?: string }
  ): Promise<{ proposalId: string; case: 'A' | 'B' | 'C' }> {
    // 1. Classifica erro (retorna null se não catalogado)
    const classification = await this.classifier.classify(
      context.taskId,
      context.subtaskId ?? null,
      context.generation,
      error
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

  /**
   * Invoca Monitor para análise (TODO: implementação real com LLM)
   */
  private async invokeMonitor(
    context: PrimitiveContext,
    error: { code?: string; message?: string; stack?: string }
  ): Promise<MonitorProposal> {
    // TODO: Implementar chamada real ao Monitor via Console API
    // Por enquanto, simula proposta de Caso B (evento novo)
    
    const proposalId = `proposal-${++this.proposalCounter}-${Date.now()}`
    
    return {
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
    return proposalId
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
