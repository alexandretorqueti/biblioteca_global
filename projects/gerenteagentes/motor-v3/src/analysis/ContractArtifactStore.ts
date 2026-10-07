import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentWorkspaceResolver } from '../agent-workspace/AgentWorkspaceResolver.js'
import type { ConsoleHttpApi } from './ConsoleHttpApi.js'

export interface ContractArtifactInput {
  agentId: string
  promptKey: string
  contractVersionId: number
  instructions: string
  schema: unknown
  example: unknown
}

export interface ContractArtifact {
  path: string
  version: number
  sha256: string
}

/** Materializa o contrato no workspace do agente sem sujar o repositório. */
export class ContractArtifactStore {
  private readonly workspaceResolver: AgentWorkspaceResolver

  constructor(
    private readonly agentWorkspacesRoot: string | undefined,
    consoleApi: ConsoleHttpApi,
  ) {
    this.workspaceResolver = new AgentWorkspaceResolver(consoleApi)
  }

  async materialize(input: ContractArtifactInput): Promise<ContractArtifact> {
    const agentId = safeSegment(input.agentId, 'agentId')
    const promptKey = safeSegment(input.promptKey, 'promptKey')
    
    // Resolve o workspace correto do agente via API do OpenClaw
    const agentWorkspace = await this.workspaceResolver.resolveWorkspace(
      agentId,
      this.agentWorkspacesRoot ?? '/data/workspace/projects/agentes',
    )
    
    const payload = JSON.stringify({
      format: 'motor-v3.analysis-contract/v1',
      promptKey: input.promptKey,
      contractVersion: input.contractVersionId,
      instructions: input.instructions,
      schema: input.schema,
      example: input.example,
    }, null, 2) + '\n'
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const directory = resolve(agentWorkspace, '.motor', 'contracts', promptKey)
    const path = resolve(directory, `v${input.contractVersionId}-${sha256.slice(0, 12)}.json`)
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o644 })
    await rename(temporary, path)
    return { path, version: input.contractVersionId, sha256 }
  }
}

function safeSegment(value: string, field: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`${field} inválido para contrato: ${value}`)
  return value
}
