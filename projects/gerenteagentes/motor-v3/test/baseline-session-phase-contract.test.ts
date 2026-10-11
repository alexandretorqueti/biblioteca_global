// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('contrato persistente da sessão baseline_fix', () => {
  it('mantém código, schema e migration alinhados com a fase baseline_fix', async () => {
    const [start, schema, migration] = await Promise.all([
      readFile(new URL('../src/start.ts', import.meta.url), 'utf8'),
      readFile(`${projectRoot}/schema.ts`, 'utf8'),
      readFile(`${projectRoot}/migrations/0084_motor_baseline_fix_context_phase.sql`, 'utf8'),
    ])

    expect(start).toContain("VALUES (?, ?, 'baseline_fix'")
    expect(schema).toContain('mysqlEnum("fase", ["analysis", "development", "baseline_fix"])')
    expect(migration).toMatch(/MODIFY COLUMN `fase` ENUM\('analysis', 'development', 'baseline_fix'\) NOT NULL/)
  })
})
