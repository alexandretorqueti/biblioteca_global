import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MonitorPromptResolver, MONITOR_RESOLUTION_PROMPT_KEY } from '../src/monitor/index.js'
import type { MonitorPromptMarkers } from '../src/monitor/index.js'

const TEXTO_BASE = [
  '## Missão — Resolução de Bloqueio (Monitor)',
  'Tarefa: **IDTAREFA** — **TITULOTAREFA**',
  'Subtarefa: **IDSUBTAREFA**',
  'Repositório: **REPOSITORIO**',
  'Branch base: **BRANCHBASE**',
  'Branch do dev: **BRANCHDEV**',
  'Branch de integração: **BRANCHINTEGRACAO**',
  'Workspace da tarefa: **WORKSPACE**',
  'Motivo: **MOTIVOBLOQUEIO**',
  'Comando: **COMANDO**',
  'Evidência: **EVIDENCIA**',
].join('\n')

function markers(overrides: Partial<MonitorPromptMarkers> = {}): MonitorPromptMarkers {
  return {
    taskId: 'task-p1-886',
    taskTitle: 'Configuração de conexão MySQL por projeto',
    subtaskId: '1184',
    repository: '/repo/biblioteca-global',
    baseBranch: 'base-desenvolvimento',
    devBranch: 'motor-v3-work/subtask-task-p1-886-1184-a1',
    integrationBranch: 'motor-v3-work/integration-task-p1-886',
    workspace: '/worktrees/task-p1-886/integration',
    blockReason: 'deploy_failed',
    blockCommand: 'motor-v3:deploy:batch-1',
    evidence: 'script blue-green informou falha',
    ...overrides,
  }
}

function fakePool(activeRow: { prompt_id: number; version_id: number; texto: string } | null) {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params: params ?? [] })
      if (normalized.includes('FROM prompts_agentes p')) {
        return [activeRow ? [activeRow] : [], []]
      }
      if (normalized.startsWith('INSERT INTO prompts_execucoes')) {
        return [{ insertId: 99 }, []]
      }
      return [{ affectedRows: 1 }, []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('MonitorPromptResolver', () => {
  it('resolve a versão ativa pelo chave e renderiza todos os marcadores', async () => {
    const { pool } = fakePool({ prompt_id: 11, version_id: 50, texto: TEXTO_BASE })
    const resolver = new MonitorPromptResolver(pool)

    const resolved = await resolver.resolve('task-p1-886', markers())

    expect(resolved.promptId).toBe(11)
    expect(resolved.versionId).toBe(50)
    expect(resolved.text).toContain('Tarefa: task-p1-886 — Configuração de conexão MySQL por projeto')
    expect(resolved.text).toContain('Subtarefa: 1184')
    expect(resolved.text).toContain('Branch base: base-desenvolvimento')
    expect(resolved.text).toContain('Branch do dev: motor-v3-work/subtask-task-p1-886-1184-a1')
    expect(resolved.text).toContain('Branch de integração: motor-v3-work/integration-task-p1-886')
    expect(resolved.text).toContain('Workspace da tarefa: /worktrees/task-p1-886/integration')
    expect(resolved.text).toContain('Motivo: deploy_failed')
    expect(resolved.text).toContain('Comando: motor-v3:deploy:batch-1')
    expect(resolved.text).toContain('Evidência: script blue-green informou falha')
    expect(resolved.text).not.toContain('**')
  })

  it('busca somente prompt ativo pela chave canônica', async () => {
    const { pool, queries } = fakePool({ prompt_id: 11, version_id: 50, texto: TEXTO_BASE })
    await new MonitorPromptResolver(pool).resolve('task-p1-886', markers())

    const select = queries[0]
    expect(select.sql).toContain("p.status = 'active'")
    expect(select.params).toEqual([MONITOR_RESOLUTION_PROMPT_KEY])
  })

  it('audita o uso em prompts_execucoes com o prompt final e os marcadores', async () => {
    const { pool, queries } = fakePool({ prompt_id: 11, version_id: 50, texto: TEXTO_BASE })
    const resolved = await new MonitorPromptResolver(pool).resolve('task-p1-886', markers())

    const insert = queries.find(query => query.sql.startsWith('INSERT INTO prompts_execucoes'))
    expect(insert).toBeDefined()
    expect(insert!.params).toEqual([11, 50, MONITOR_RESOLUTION_PROMPT_KEY, 'task-p1-886'])

    const update = queries.find(query => query.sql.startsWith('UPDATE prompts_execucoes'))
    expect(update).toBeDefined()
    expect(update!.params[0]).toBe(resolved.text)
    expect(JSON.parse(update!.params[1] as string)).toMatchObject({ key: MONITOR_RESOLUTION_PROMPT_KEY })
    expect(update!.params[2]).toBe(99)
  })

  it('falha com prompt_configuration_missing quando não há versão ativa', async () => {
    const { pool } = fakePool(null)
    await expect(new MonitorPromptResolver(pool).resolve('task-p1-886', markers()))
      .rejects.toThrow(`prompt_configuration_missing: prompt ativo não encontrado: ${MONITOR_RESOLUTION_PROMPT_KEY}`)
  })
})
