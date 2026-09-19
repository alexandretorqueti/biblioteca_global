/**
 * SandboxConfig — gera configuração de sandbox OpenClaw para execução de agentes
 * 
 * F5: Sandbox e muros finais
 * - Opção (a): raiz de worktrees montada
 * - Binds: worktree (rw) + referências (ro)
 * - Rede: default none + allowlist (Console, Ollama, npm, provedores cloud)
 * - readOnlyRoot: true
 * - capDrop: ALL
 * - Sem credenciais git (motor faz push/merge FORA do sandbox)
 * 
 * Esta classe gera o objeto de config que deve ser aplicado ao OpenClaw Gateway
 * via gateway config.patch. O motor chama a API do OpenClaw para criar sessões
 * no sandbox, mas a config do sandbox é persistida no Gateway.
 */

export interface SandboxBind {
  hostPath: string
  containerPath: string
  readOnly: boolean
}

export interface SandboxNetworkRule {
  type: 'allow' | 'deny'
  host?: string
  port?: number
  protocol?: 'tcp' | 'udp'
  description?: string
}

export interface SandboxConfig {
  // Agent identification
  agentId: string
  taskId: string
  subtaskId?: number
  executionId: string

  // Docker sandbox settings
  mode: 'non-main' | 'all'
  scope: 'session'
  backend: 'docker'

  // Security
  readOnlyRoot: boolean
  capDrop: string[]

  // Binds (mounts)
  binds: SandboxBind[]

  // Network
  networkMode: 'none' | 'bridge' | 'allowlist'
  networkAllowlist: SandboxNetworkRule[]

  // Timeouts
  sessionTimeoutMs: number
  heartbeatIntervalMs: number
}

export interface SandboxConfigOptions {
  // Required
  agentId: string
  taskId: string
  executionId: string
  worktreePath: string // Host path to worktree

  // Optional
  subtaskId?: number
  references?: Array<{ hostPath: string; name: string }> // Referências da tarefa
  sandboxRoot?: string // Raiz dos worktrees (default: /data/workspace/agentes/motor-v3/worktrees)
  
  // Network
  consoleUrl?: string // Console OpenClaw (default: http://127.0.0.1:6280)
  ollamaUrl?: string // Ollama (default: http://ollama:11434)
  npmRegistry?: string // npm registry (default: https://registry.npmjs.org)
  cloudModelProviders?: string[] // URLs de provedores cloud (ex: https://api.openai.com)

  // Timeouts
  sessionTimeoutMs?: number
  heartbeatIntervalMs?: number
}

export class SandboxConfigGenerator {
  /**
   * Gera configuração completa de sandbox para uma execução
   */
  static generate(options: SandboxConfigOptions): SandboxConfig {
    const binds = this.generateBinds(options)
    const networkAllowlist = this.generateNetworkAllowlist(options)

    return {
      agentId: options.agentId,
      taskId: options.taskId,
      subtaskId: options.subtaskId,
      executionId: options.executionId,

      mode: 'non-main',
      scope: 'session',
      backend: 'docker',

      readOnlyRoot: true,
      capDrop: ['ALL'],

      binds,
      networkMode: 'allowlist',
      networkAllowlist,

      sessionTimeoutMs: options.sessionTimeoutMs ?? 3600000, // 1 hora
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60000, // 1 minuto
    }
  }

  /**
   * Gera binds do sandbox
   */
  private static generateBinds(options: SandboxConfigOptions): SandboxBind[] {
    const binds: SandboxBind[] = []

    // Worktree (rw — único ponto de escrita)
    binds.push({
      hostPath: options.worktreePath,
      containerPath: '/work',
      readOnly: false,
    })

    // Referências da tarefa (ro)
    if (options.references) {
      options.references.forEach((ref, index) => {
        binds.push({
          hostPath: ref.hostPath,
          containerPath: `/refs/${index + 1}`,
          readOnly: true,
        })
      })
    }

    return binds
  }

  /**
   * Gera allowlist de rede
   */
  private static generateNetworkAllowlist(options: SandboxConfigOptions): SandboxNetworkRule[] {
    const allowlist: SandboxNetworkRule[] = []

    // Console OpenClaw (conversa com agente)
    const consoleUrl = options.consoleUrl ?? 'http://127.0.0.1:6280'
    const consoleParsed = new URL(consoleUrl)
    allowlist.push({
      type: 'allow',
      host: consoleParsed.hostname,
      port: parseInt(consoleParsed.port || '6280'),
      protocol: 'tcp',
      description: 'Console OpenClaw (conversa)',
    })

    // Ollama (modelo local)
    if (options.ollamaUrl) {
      const ollamaParsed = new URL(options.ollamaUrl)
      allowlist.push({
        type: 'allow',
        host: ollamaParsed.hostname,
        port: parseInt(ollamaParsed.port || '11434'),
        protocol: 'tcp',
        description: 'Ollama (modelo local)',
      })
    }

    // npm registry
    const npmRegistry = options.npmRegistry ?? 'https://registry.npmjs.org'
    const npmParsed = new URL(npmRegistry)
    allowlist.push({
      type: 'allow',
      host: npmParsed.hostname,
      port: 443,
      protocol: 'tcp',
      description: 'npm registry',
    })

    // Provedores cloud de modelo
    if (options.cloudModelProviders) {
      options.cloudModelProviders.forEach(providerUrl => {
        const parsed = new URL(providerUrl)
        allowlist.push({
          type: 'allow',
          host: parsed.hostname,
          port: parseInt(parsed.port || '443'),
          protocol: 'tcp',
          description: `Cloud model provider: ${parsed.hostname}`,
        })
      })
    }

    return allowlist
  }

  /**
   * Converte config para formato OpenClaw Gateway (config.patch)
   */
  static toGatewayConfig(config: SandboxConfig): Record<string, any> {
    return {
      agents: {
        list: {
          [config.agentId]: {
            sandbox: {
              mode: config.mode,
              scope: config.scope,
              backend: config.backend,
              docker: {
                readOnlyRoot: config.readOnlyRoot,
                capDrop: config.capDrop,
                network: config.networkMode === 'allowlist' ? 'none' : config.networkMode,
                networkAllowlist: config.networkAllowlist.map(rule => ({
                  type: rule.type,
                  host: rule.host,
                  port: rule.port,
                  protocol: rule.protocol,
                })),
              },
              binds: config.binds.map(bind => ({
                hostPath: bind.hostPath,
                containerPath: bind.containerPath,
                readOnly: bind.readOnly,
              })),
            },
          },
        },
      },
    }
  }

  /**
   * Valida que o agente não tem acesso a credenciais git
   */
  static validateNoGitCredentials(config: SandboxConfig): { valid: boolean; issues: string[] } {
    const issues: string[] = []

    // Verifica se nenhum bind aponta para ~/.ssh
    for (const bind of config.binds) {
      if (bind.hostPath.includes('/.ssh') || bind.hostPath.includes('.ssh')) {
        issues.push(`Bind ${bind.hostPath} aponta para credenciais SSH`)
      }
    }

    // Verifica se nenhum bind aponta para secrets/
    for (const bind of config.binds) {
      if (bind.hostPath.includes('/secrets/') || bind.hostPath.includes('secrets/')) {
        issues.push(`Bind ${bind.hostPath} aponta para diretório de secrets`)
      }
    }

    // Verifica se nenhum bind aponta para .env
    for (const bind of config.binds) {
      if (bind.hostPath.includes('.env')) {
        issues.push(`Bind ${bind.hostPath} aponta para arquivo .env`)
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    }
  }

  /**
   * Valida que o worktree é o único ponto de escrita
   */
  static validateSingleWritePoint(config: SandboxConfig): { valid: boolean; issues: string[] } {
    const issues: string[] = []

    const rwBinds = config.binds.filter(b => !b.readOnly)
    
    if (rwBinds.length === 0) {
      issues.push('Nenhum bind rw encontrado (worktree deve ser rw)')
    } else if (rwBinds.length > 1) {
      issues.push(`Múltiplos binds rw encontrados: ${rwBinds.map(b => b.containerPath).join(', ')}`)
    }

    // Verifica se o único bind rw é o worktree
    if (rwBinds.length === 1 && rwBinds[0] && rwBinds[0].containerPath !== '/work') {
      issues.push(`Bind rw deveria ser /work (worktree), mas é ${rwBinds[0].containerPath}`)
    }

    return {
      valid: issues.length === 0,
      issues,
    }
  }
}
