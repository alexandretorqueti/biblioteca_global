import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { insertDeduplicatedChatMessage } from '../execution/blockerChatAlert.js'
import { RealtimeMutationBoundary } from '../realtime/RealtimeMutationBoundary.js'

/**
 * Porta de notificação humana do Monitor-Resolvedor.
 *
 * Quando o Monitor NÃO resolve um bloqueio (NAO_RESOLVIDO, resposta fora do
 * contrato, worker sem sucesso, sem cadeia MONITOR configurada ou falha final
 * da missão), o humano precisa saber — a tarefa não pode ficar travada em
 * silêncio.
 *
 * Decisão do usuário (tarefa 1043): o canal do alerta é o **chat da tarefa na
 * plataforma** (`tarefa_chats`), não Telegram. `TaskChatHumanNotifier` grava a
 * mensagem 'assistant' com deduplicação por marcador estável (blockId quando
 * disponível; caso contrário digest de taskId+blockReason+resumo) usando o
 * mesmo padrão `INSERT ... WHERE NOT EXISTS` de `blockerChatAlert.ts`, e mantém
 * log estruturado como eco diagnóstico.
 *
 * PENDÊNCIA FORA DE ESCOPO (tarefa 1043): a lacuna do `MonitorBridge.notifyHuman`
 * (catálogo/monitor-bridge, ainda log-only) permanece — não faz parte desta
 * subtarefa. Nenhum cliente Telegram é implementado aqui.
 *
 * A interface continua plugável: qualquer implementação de
 * `MonitorHumanNotifier` (ex.: entrega externa futura) pode ser injetada nos
 * consumidores sem alterá-los.
 */
export interface MonitorHumanNotifyInput {
  /** Id externo/legível da tarefa (ex.: task-p2-1043) ou id numérico. */
  taskId: string
  /** Causa do bloqueio (bloqueios.block_reason ou reason sintético do Monitor). */
  blockReason: string
  /** Evidência/resumo legível do que o Monitor apurou. */
  summary: string
  /** Id do bloqueio (bloqueios.id) quando disponível no contexto da chamada — ancora a deduplicação. */
  blockId?: number | string | null
}

export interface MonitorHumanNotifier {
  notify(input: MonitorHumanNotifyInput): Promise<void>
}

/**
 * Marcador estável de deduplicação embutido no texto da mensagem:
 * - com blockId numérico válido → `[motor-v3:monitor-notify:block:<blockId>]`
 *   (redelivery/tentativas repetidas do MESMO bloqueio não duplicam o alerta);
 * - sem blockId → digest sha256 de `taskId|blockReason|summary` (alertas
 *   idênticos para o mesmo contexto também colapsam em uma mensagem).
 */
export function monitorNotifyMarker(input: MonitorHumanNotifyInput): string {
  const blockId = Number(input.blockId)
  if (input.blockId != null && Number.isInteger(blockId) && blockId > 0) {
    return `[motor-v3:monitor-notify:block:${blockId}]`
  }
  const digest = createHash('sha256')
    .update(`${input.taskId}|${input.blockReason}|${input.summary}`)
    .digest('hex')
    .slice(0, 32)
  return `[motor-v3:monitor-notify:${digest}]`
}

/** Texto do alerta ao operador: causa, evidência e ação recomendada + marcador. */
export function buildMonitorAlertText(input: MonitorHumanNotifyInput): string {
  return [
    '🚨 **Monitor: bloqueio não resolvido — ação humana necessária**',
    '',
    `**Tarefa:** ${input.taskId}`,
    `**Causa:** ${String(input.blockReason).slice(0, 500)}`,
    `**Evidência:** ${String(input.summary).slice(0, 2_000)}`,
    '**Ação recomendada:** revise o bloqueio no Mapa de agentes, corrija a causa raiz e resolva o bloqueio para retomar a tarefa a partir da subtarefa correta.',
    '',
    monitorNotifyMarker(input),
  ].join('\n').slice(0, 8_000)
}

/** Contrato mínimo de pool aceito pela implementação real (facilita testes). */
export type HumanNotifierPool = Pick<Pool, 'query'> & Partial<Pick<Pool, 'getConnection'>>

/**
 * Notificador humano real: grava o alerta no chat da tarefa (`tarefa_chats`,
 * role 'assistant') com deduplicação por marcador estável, e propaga o evento
 * realtime do chat em melhor-esforço (mesmo padrão do `safePostChat` do
 * MonitorResolutionConsumer). Falhas nunca derrubam o fluxo do Monitor — o
 * chamador já trata a notificação como melhor-esforço, e aqui também registramos
 * o eco diagnóstico em log estruturado.
 */
export class TaskChatHumanNotifier implements MonitorHumanNotifier {
  constructor(private readonly pool: HumanNotifierPool) {}

  async notify(input: MonitorHumanNotifyInput): Promise<void> {
    // Eco diagnóstico (log estruturado) — permanece mesmo com entrega real.
    console.warn(
      `[Monitor] ⚠️ tarefa=${input.taskId} bloqueio=${input.blockReason} blockId=${input.blockId ?? '—'} NÃO resolvido — alerta no chat da tarefa`,
    )
    console.warn(`[Monitor] Resumo: ${input.summary}`)
    try {
      const databaseTaskId = await this.resolveDatabaseTaskId(input.taskId)
      if (databaseTaskId == null) {
        console.warn(`[Monitor] TaskChatHumanNotifier: tarefa ${input.taskId} não encontrada; alerta não gravado no chat.`)
        return
      }
      const texto = buildMonitorAlertText(input)
      const marker = monitorNotifyMarker(input)
      const created = await insertDeduplicatedChatMessage(this.pool, databaseTaskId, marker, texto)
      if (!created) {
        console.warn(`[Monitor] TaskChatHumanNotifier: alerta já existente (marcador ${marker}) — deduplicado.`)
        return
      }
      await this.enqueueRealtime(databaseTaskId, created)
    } catch (error) {
      console.warn(
        '[Monitor] TaskChatHumanNotifier: falha ao gravar alerta no chat:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Resolve o id numérico de `tarefas` a partir do taskId externo ou numérico. */
  private async resolveDatabaseTaskId(taskId: string): Promise<number | null> {
    const numeric = /^\d+$/.test(taskId)
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number }>>(
      numeric
        ? 'SELECT id FROM tarefas WHERE external_id = ? OR CAST(id AS CHAR) = ? LIMIT 1'
        : 'SELECT id FROM tarefas WHERE external_id = ? LIMIT 1',
      numeric ? [taskId, taskId] : [taskId],
    )
    const id = Number(rows[0]?.id)
    return Number.isInteger(id) && id > 0 ? id : null
  }

  /** Evento realtime do chat em melhor-esforço (tela acompanha sem reload). */
  private async enqueueRealtime(databaseTaskId: number, message: { id: number; texto: string }): Promise<void> {
    if (typeof this.pool.getConnection !== 'function') return
    try {
      const realtime = new RealtimeMutationBoundary(this.pool as Pool)
      await realtime.enqueueChatMessage(databaseTaskId, {
        id: message.id, role: 'assistant', texto: message.texto,
      })
    } catch {
      // Realtime é melhor-esforço; o alerta já está persistido no chat.
    }
  }
}

/**
 * Notificador log-only (fallback sem banco, ex.: testes rápidos/ambientes
 * degradados). Mantido para preservar a interface plugável; a implementação
 * padrão de produção é `TaskChatHumanNotifier`.
 */
export class ConsoleHumanNotifier implements MonitorHumanNotifier {
  async notify(input: MonitorHumanNotifyInput): Promise<void> {
    console.warn(`[Monitor] ⚠️ tarefa=${input.taskId} bloqueio=${input.blockReason} NÃO resolvido (notificador log-only)`)
    console.warn(`[Monitor] Resumo: ${input.summary}`)
  }
}
