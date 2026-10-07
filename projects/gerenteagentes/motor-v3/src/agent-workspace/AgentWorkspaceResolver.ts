import type { ConsoleHttpApi } from '../analysis/ConsoleHttpApi.js'

export interface OpenClawAgent {
  id: string
  workspace?: string
}

/**
 * Resolve o workspace de um agente usando a API HTTP do OpenClaw Console.
 * 
 * O OpenClaw Console expõe um endpoint `/api/agents` que retorna todos os
 * agentes configurados, incluindo seus workspaces. Este serviço consulta essa
 * lista para resolver o workspace correto de um agentId.
 * 
 * Exemplo: agentId "programador-senior" -> workspace "/data/workspace/projects/agentes/gerenteagentes"
 */
export class AgentWorkspaceResolver {
  private agentMap: Map<string, string> | null = null
  private loadPromise: Promise<Map<string, string>> | null = null
  private lastLoadTime = 0
  private readonly cacheTtlMs = 60_000 // 1 minuto

  constructor(
    private readonly consoleApi: ConsoleHttpApi,
  ) {}

  /**
   * Resolve o workspace de um agente.
   * 
   * @param agentId - ID do agente no OpenClaw (ex: "programador-senior")
   * @param fallbackRoot - Raiz fallback caso o workspace não esteja configurado (default: /data/workspace/projects/agentes)
   * @returns Caminho absoluto do workspace do agente
   */
  async resolveWorkspace(agentId: string, fallbackRoot = '/data/workspace/projects/agentes'): Promise<string> {
    const map = await this.loadAgentMap()
    const workspace = map.get(agentId)
    
    if (workspace) {
      return workspace
    }
    
    // Fallback: usa agentId como subpasta da raiz padrão
    return `${fallbackRoot}/${agentId}`
  }

  /**
   * Carrega o mapa de agentId -> workspace via API HTTP do OpenClaw Console.
   * Usa cache com TTL para evitar chamadas repetidas.
   */
  private async loadAgentMap(): Promise<Map<string, string>> {
    const now = Date.now()
    
    // Retorna cache se ainda válido
    if (this.agentMap && (now - this.lastLoadTime) < this.cacheTtlMs) {
      return this.agentMap
    }

    // Se já está carregando, aguarda
    if (this.loadPromise) {
      return this.loadPromise
    }

    this.loadPromise = this.doLoadAgentMap()
    
    try {
      this.agentMap = await this.loadPromise
      this.lastLoadTime = Date.now()
      return this.agentMap
    } finally {
      this.loadPromise = null
    }
  }

  private async doLoadAgentMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>()

    try {
      const agents = await this.consoleApi.listAgents()
      
      for (const agent of agents) {
        if (agent.id && agent.workspace) {
          map.set(agent.id, agent.workspace)
        }
      }
    } catch (error) {
      console.warn('[AgentWorkspaceResolver] Erro ao listar agentes via API:', error)
    }

    return map
  }

  /**
   * Invalida o cache do mapa de workspaces.
   * Útil quando a configuração do OpenClaw é alterada.
   */
  invalidateCache(): void {
    this.agentMap = null
    this.lastLoadTime = 0
  }
}
