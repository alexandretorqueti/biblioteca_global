import { describe, it, expect } from 'vitest'
import { SandboxConfigGenerator } from '../src/sandbox/SandboxConfig.js'

describe('SandboxConfigGenerator', () => {
  const baseOptions = {
    agentId: 'test-agent',
    taskId: 'task-123',
    executionId: 'exec-789',
    worktreePath: '/data/workspace/agentes/motor-v3/worktrees/task-123/sub-456/a1',
  }

  describe('generate', () => {
    it('should generate complete sandbox config', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)

      expect(config.agentId).toBe('test-agent')
      expect(config.taskId).toBe('task-123')
      expect(config.executionId).toBe('exec-789')
      expect(config.mode).toBe('non-main')
      expect(config.scope).toBe('session')
      expect(config.backend).toBe('docker')
      expect(config.readOnlyRoot).toBe(true)
      expect(config.capDrop).toEqual(['ALL'])
      expect(config.networkMode).toBe('allowlist')
    })

    it('should include subtaskId when provided', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        subtaskId: 456,
      })

      expect(config.subtaskId).toBe(456)
    })

    it('should use default timeouts when not provided', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)

      expect(config.sessionTimeoutMs).toBe(3600000) // 1 hora
      expect(config.heartbeatIntervalMs).toBe(60000) // 1 minuto
    })

    it('should use custom timeouts when provided', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        sessionTimeoutMs: 7200000,
        heartbeatIntervalMs: 120000,
      })

      expect(config.sessionTimeoutMs).toBe(7200000)
      expect(config.heartbeatIntervalMs).toBe(120000)
    })
  })

  describe('binds', () => {
    it('should include worktree as rw bind', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)

      expect(config.binds).toHaveLength(1)
      expect(config.binds[0]).toEqual({
        hostPath: baseOptions.worktreePath,
        containerPath: '/work',
        readOnly: false,
      })
    })

    it('should include references as ro binds', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        references: [
          { hostPath: '/data/refs/spec.md', name: 'spec' },
          { hostPath: '/data/refs/config.json', name: 'config' },
        ],
      })

      expect(config.binds).toHaveLength(3) // worktree + 2 refs
      expect(config.binds[1]).toEqual({
        hostPath: '/data/refs/spec.md',
        containerPath: '/refs/1',
        readOnly: true,
      })
      expect(config.binds[2]).toEqual({
        hostPath: '/data/refs/config.json',
        containerPath: '/refs/2',
        readOnly: true,
      })
    })
  })

  describe('network allowlist', () => {
    it('should include default console URL', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)

      const consoleRule = config.networkAllowlist.find(r => r.description?.includes('Console'))
      expect(consoleRule).toBeDefined()
      expect(consoleRule?.host).toBe('127.0.0.1')
      expect(consoleRule?.port).toBe(6280)
    })

    it('should include custom console URL', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        consoleUrl: 'http://console.example.com:8080',
      })

      const consoleRule = config.networkAllowlist.find(r => r.description?.includes('Console'))
      expect(consoleRule?.host).toBe('console.example.com')
      expect(consoleRule?.port).toBe(8080)
    })

    it('should include Ollama when provided', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        ollamaUrl: 'http://ollama:11434',
      })

      const ollamaRule = config.networkAllowlist.find(r => r.description?.includes('Ollama'))
      expect(ollamaRule).toBeDefined()
      expect(ollamaRule?.host).toBe('ollama')
      expect(ollamaRule?.port).toBe(11434)
    })

    it('should include npm registry', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)

      const npmRule = config.networkAllowlist.find(r => r.description?.includes('npm'))
      expect(npmRule).toBeDefined()
      expect(npmRule?.host).toBe('registry.npmjs.org')
      expect(npmRule?.port).toBe(443)
    })

    it('should include cloud model providers', () => {
      const config = SandboxConfigGenerator.generate({
        ...baseOptions,
        cloudModelProviders: [
          'https://api.openai.com',
          'https://api.anthropic.com',
        ],
      })

      const openaiRule = config.networkAllowlist.find(r => r.host === 'api.openai.com')
      expect(openaiRule).toBeDefined()
      expect(openaiRule?.port).toBe(443)

      const anthropicRule = config.networkAllowlist.find(r => r.host === 'api.anthropic.com')
      expect(anthropicRule).toBeDefined()
    })
  })

  describe('toGatewayConfig', () => {
    it('should convert to OpenClaw Gateway config format', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      const gatewayConfig = SandboxConfigGenerator.toGatewayConfig(config)

      expect(gatewayConfig.agents.list['test-agent']).toBeDefined()
      expect(gatewayConfig.agents.list['test-agent'].sandbox.mode).toBe('non-main')
      expect(gatewayConfig.agents.list['test-agent'].sandbox.docker.readOnlyRoot).toBe(true)
      expect(gatewayConfig.agents.list['test-agent'].sandbox.docker.capDrop).toEqual(['ALL'])
      expect(gatewayConfig.agents.list['test-agent'].sandbox.binds).toHaveLength(1)
    })
  })

  describe('validateNoGitCredentials', () => {
    it('should pass when no credentials are exposed', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      const validation = SandboxConfigGenerator.validateNoGitCredentials(config)

      expect(validation.valid).toBe(true)
      expect(validation.issues).toHaveLength(0)
    })

    it('should detect .ssh exposure', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds.push({
        hostPath: '/home/user/.ssh',
        containerPath: '/ssh',
        readOnly: true,
      })

      const validation = SandboxConfigGenerator.validateNoGitCredentials(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('.ssh')
    })

    it('should detect secrets exposure', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds.push({
        hostPath: '/data/secrets/',
        containerPath: '/secrets',
        readOnly: true,
      })

      const validation = SandboxConfigGenerator.validateNoGitCredentials(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('secrets')
    })

    it('should detect .env exposure', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds.push({
        hostPath: '/data/.env',
        containerPath: '/env',
        readOnly: true,
      })

      const validation = SandboxConfigGenerator.validateNoGitCredentials(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('.env')
    })
  })

  describe('validateSingleWritePoint', () => {
    it('should pass when only worktree is rw', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      const validation = SandboxConfigGenerator.validateSingleWritePoint(config)

      expect(validation.valid).toBe(true)
      expect(validation.issues).toHaveLength(0)
    })

    it('should fail when no rw binds exist', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds[0].readOnly = true // Torna worktree ro

      const validation = SandboxConfigGenerator.validateSingleWritePoint(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('Nenhum bind rw')
    })

    it('should fail when multiple rw binds exist', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds.push({
        hostPath: '/extra/path',
        containerPath: '/extra',
        readOnly: false,
      })

      const validation = SandboxConfigGenerator.validateSingleWritePoint(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('Múltiplos binds rw')
    })

    it('should fail when rw bind is not /work', () => {
      const config = SandboxConfigGenerator.generate(baseOptions)
      config.binds[0].containerPath = '/workspace' // Muda de /work

      const validation = SandboxConfigGenerator.validateSingleWritePoint(config)

      expect(validation.valid).toBe(false)
      expect(validation.issues[0]).toContain('/work')
    })
  })
})
