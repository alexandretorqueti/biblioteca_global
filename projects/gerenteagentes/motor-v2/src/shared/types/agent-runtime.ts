/**
 * Tipos do Agent Runtime Driver
 * 
 * Substitui imports de @gerente-agentes/openclaw-runtime-driver.
 * Interface mínima necessária para o MotorMonitorStep.
 */

/** Resultado do envio de mensagem */
export interface SendMessageResult {
  ok: boolean
  runId?: string
  reason?: string
}

/** Resultado do status de um run */
export interface RunStatusResult {
  status: 'pending' | 'running' | 'completed' | 'failed'
}

/** Parâmetros para enviar mensagem */
export interface SendMessageParams {
  agentId: string
  sessionKey: string
  message: string
}

/** Driver do Agent Runtime (OpenClaw) */
export interface AgentRuntimeDriver {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>
  getRunStatus(runId: string): Promise<RunStatusResult>
}
