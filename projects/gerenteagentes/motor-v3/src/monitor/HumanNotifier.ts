/**
 * Porta de notificação humana do Monitor-Resolvedor.
 *
 * Quando o Monitor NÃO resolve um bloqueio (NAO_RESOLVIDO, resposta fora do
 * contrato, worker sem sucesso), o humano precisa saber — a tarefa não pode
 * ficar travada em silêncio. O motor-v3 ainda não tem cliente Telegram real
 * (o notifyHuman do MonitorBridge também é log-only); a implementação padrão
 * registra em log estruturado e a interface fica pronta para plugar a entrega
 * real (via Console/OpenClaw ou API do bot) sem tocar no consumidor.
 */
export interface MonitorHumanNotifier {
  notify(input: { taskId: string; blockReason: string; summary: string }): Promise<void>
}

export class ConsoleHumanNotifier implements MonitorHumanNotifier {
  constructor(private readonly telegramTarget: string = process.env.MOTOR_TELEGRAM_TARGET || '7147090795') {}

  async notify(input: { taskId: string; blockReason: string; summary: string }): Promise<void> {
    // TODO: entrega real via Telegram (mesma lacuna do MonitorBridge.notifyHuman).
    console.warn(`[Monitor] ⚠️ tarefa=${input.taskId} bloqueio=${input.blockReason} NÃO resolvido — notificar target=${this.telegramTarget}`)
    console.warn(`[Monitor] Resumo: ${input.summary}`)
  }
}
