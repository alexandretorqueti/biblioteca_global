import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENQUEUED_COMMAND_TYPE } from '../src/coordinator/TaskEnqueuedConsumer.js'

/**
 * Contrato estático: nenhum comando despachado pela API HTTP do motor-v3 pode
 * ficar sem consumidor (task-p2-1047, subtarefa 3 — `TASK_ENQUEUED` era
 * despachado pelo endpoint `/enqueue` e ackado em silêncio; regra do projeto:
 * "nenhuma mensagem de comando pode ser despachada sem consumidor").
 *
 * O teste lê `src/start.ts`, extrai os tipos despachados via `dispatchCommand`
 * e exige que `TASK_ENQUEUED` tenha consumidor registrado no pipeline do
 * `QueueConsumer` (instância + chamada `handle` na cadeia).
 */
const here = dirname(fileURLToPath(import.meta.url))
const startSource = readFileSync(resolve(here, '../src/start.ts'), 'utf8')

function dispatchedCommandTypes(source: string): string[] {
  const types = new Set<string>()
  for (const match of source.matchAll(/dispatchCommand\(\s*'([A-Z_]+)'/g)) types.add(match[1])
  return [...types]
}

describe('contrato dispatch↔consumidor (TASK_ENQUEUED)', () => {
  it('o endpoint /enqueue continua despachando TASK_ENQUEUED (uso real: setup da Biblioteca)', () => {
    expect(dispatchedCommandTypes(startSource)).toContain('TASK_ENQUEUED')
    expect(ENQUEUED_COMMAND_TYPE).toBe('TASK_ENQUEUED')
  })

  it('TASK_ENQUEUED tem consumidor registrado e ligado à cadeia do QueueConsumer', () => {
    // Importação/instanciação do consumidor dedicado.
    expect(startSource).toContain('TaskEnqueuedConsumer')
    expect(startSource).toMatch(/taskEnqueuedConsumer\s*=\s*new TaskEnqueuedConsumer\(/)
    // Registro na cadeia de consumo da fila principal de comandos.
    expect(startSource).toMatch(/await taskEnqueuedConsumer\?\.handle\(message\)/)
  })

  it('o consumidor dedicado filtra exatamente o tipo despachado', async () => {
    const consumerSource = readFileSync(resolve(here, '../src/coordinator/TaskEnqueuedConsumer.ts'), 'utf8')
    expect(consumerSource).toContain(`message.type !== ${'ENQUEUED_COMMAND_TYPE'}`)
    expect(ENQUEUED_COMMAND_TYPE).toBe('TASK_ENQUEUED')
  })
})
