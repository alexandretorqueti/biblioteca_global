import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BATCH_TASKS_SQL } from '../src/monitor/PostDeployVerifier.js';

const schemaPath = new URL('../../schema.ts', import.meta.url);

/**
 * Extrai os nomes de colunas SQL do bloco `tarefas = mysqlTable("tarefas", {...})`
 * do schema drizzle. Cada definição de coluna tem o formato
 * `nomeTs: builder("nome_sql", ...)` — capturamos o primeiro argumento string.
 */
function tarefasColumnsFromSchema(schema: string): Set<string> {
  const start = schema.indexOf('mysqlTable("tarefas"');
  expect(start).toBeGreaterThan(-1);
  // O bloco da tabela termina na primeira linha `})` após o início.
  const end = schema.indexOf('\n})', start);
  expect(end).toBeGreaterThan(start);
  const block = schema.slice(start, end);
  const columns = new Set<string>();
  const columnDefinition = /^\s*\w+:\s*\w+\(\s*["']([a-z_][a-z_0-9]*)["']/gm;
  for (const match of block.matchAll(columnDefinition)) {
    columns.add(match[1]!);
  }
  return columns;
}

describe('contrato de colunas de PostDeployVerifier.loadBatchTasks', () => {
  it('BATCH_TASKS_SQL só referencia colunas t.<col> que existem no schema de tarefas', async () => {
    // Incidente task-p2-984 (classe do incidente 912): query referenciava
    // t.criterios_aceite, coluna inexistente — toda verificação pós-deploy
    // falhava com "Unknown column" em silêncio.
    const schema = await readFile(schemaPath, 'utf8');
    const columns = tarefasColumnsFromSchema(schema);
    expect(columns.size).toBeGreaterThan(5);

    const referenced = [...BATCH_TASKS_SQL.matchAll(/\bt\.([a-z_][a-z_0-9]*)/g)].map(m => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = [...new Set(referenced)].filter(column => !columns.has(column));
    expect(unknown).toEqual([]);
  });

  it('não seleciona a coluna fantasma criterios_aceite de tarefas', () => {
    expect(BATCH_TASKS_SQL).not.toMatch(/t\.criterios_aceite/);
    expect(BATCH_TASKS_SQL).toMatch(/NULL AS criterios_aceite/);
  });
});
