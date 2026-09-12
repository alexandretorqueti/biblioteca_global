import type { AgentRuntimeDriver, RunStatusResult, SendMessageParams, SendMessageResult } from "../shared/types/agent-runtime.js"
import { ConsoleAgentRuntimeDriver, type RuntimeSession } from "./ConsoleAgentRuntimeDriver.js"

/** Adapta o driver real do Console ao contrato usado pelo MotorMonitorStep. */
export class MonitorRuntimeAdapter implements AgentRuntimeDriver {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly runs = new Map<string, RunStatusResult>()

  constructor(private readonly driver: ConsoleAgentRuntimeDriver) {}

  async sendMessage(input: SendMessageParams): Promise<SendMessageResult> {
    let session = this.sessions.get(input.sessionKey)
    if (!session) {
      session = await this.driver.createSession({ agentId: input.agentId, key: input.sessionKey, model: input.model })
      this.sessions.set(input.sessionKey, session)
    }
    const sent = await this.driver.sendMessage({ session, message: input.message })
    this.runs.set(sent.runId, { status: "running" })
    void this.driver.waitForRunCompletion(session, sent.runId).then((completion) => {
      this.runs.set(sent.runId, completion.state === "final"
        ? { status: "completed", content: completion.content }
        : { status: "failed", content: completion.errorMessage })
    }).catch((error: unknown) => this.runs.set(sent.runId, { status: "failed", content: error instanceof Error ? error.message : String(error) }))
    return { ok: true, runId: sent.runId }
  }

  async getRunStatus(runId: string): Promise<RunStatusResult> {
    return this.runs.get(runId) ?? { status: "pending" }
  }
}
