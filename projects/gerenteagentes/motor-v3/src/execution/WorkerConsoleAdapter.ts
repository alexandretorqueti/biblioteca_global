import type { AnalystConsole, AnalystSession } from '../analysis/ConsoleAnalystRunner.js'

/** Adapta o contrato tipado do analista ao contrato legado das primitivas do worker. */
export class WorkerConsoleAdapter {
  private readonly sessions = new Map<string, AnalystSession>()

  constructor(private readonly consoleApi: AnalystConsole) {}

  async createSession(input: { key: string; agentId: string; model?: string }): Promise<{ sessionId: string }> {
    const session = await this.consoleApi.createSession({
      key: input.key,
      agentId: input.agentId,
      ...(input.model ? { model: input.model } : {}),
      metadata: {},
    })
    this.sessions.set(session.sessionId, session)
    return { sessionId: session.sessionId }
  }

  async sendMessage(input: { sessionId: string; message: string }): Promise<void> {
    await this.consoleApi.sendMessage({ session: this.requireSession(input.sessionId), message: input.message })
  }

  async getSessionStatus(sessionId: string): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }> {
    return this.consoleApi.getSessionStatus(this.requireSession(sessionId))
  }

  private requireSession(sessionId: string): AnalystSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Sessão ${sessionId} não encontrada no adaptador do worker`)
    return session
  }
}
