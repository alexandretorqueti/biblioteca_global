import type { AnalystConsole, AnalystSession } from '../analysis/ConsoleAnalystRunner.js'

export interface WorkerSessionMetadata {
  taskId?: string
  databaseTaskId?: number
  subtaskId?: number
  executionId?: string
  generation?: number
  baselineRunId?: number
  worktreePath?: string
  branchName?: string
}

export interface WorkerConsoleAdapterHooks {
  onSessionCreated?: (session: AnalystSession, input: { model?: string; metadata: WorkerSessionMetadata }) => Promise<void>
}

/** Adapta o contrato tipado do analista ao contrato legado das primitivas do worker. */
export class WorkerConsoleAdapter {
  private readonly sessions = new Map<string, AnalystSession>()
  private readonly locallyOwned = new Set<string>()

  constructor(
    private readonly consoleApi: AnalystConsole,
    private readonly hooks: WorkerConsoleAdapterHooks = {},
  ) {}

  async createSession(input: { key: string; agentId: string; model?: string; metadata?: WorkerSessionMetadata }): Promise<{ sessionId: string }> {
    const session = await this.consoleApi.createSession({
      key: input.key,
      agentId: input.agentId,
      ...(input.model ? { model: input.model } : {}),
      metadata: { ...(input.metadata ?? {}) },
    })
    this.sessions.set(session.sessionId, session)
    this.locallyOwned.add(session.sessionId)
    await this.hooks.onSessionCreated?.(session, {
      ...(input.model ? { model: input.model } : {}),
      metadata: input.metadata ?? {},
    })
    return { sessionId: session.sessionId }
  }

  attachSession(session: AnalystSession): void {
    this.sessions.set(session.sessionId, session)
  }

  isLocallyOwned(sessionId: string): boolean {
    return this.locallyOwned.has(sessionId)
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
