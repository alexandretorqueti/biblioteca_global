// @vitest-environment node
/**
 * projeto-motor-config-defaults.spec.ts — Registro automático idempotente de
 * projeto_motor_config (tarefa 1138/bloqueio 3568 — fim do "repoPath vazio").
 *
 * Cobre os critérios:
 * - defaults monorepo espelhando a linha do projeto 1 (verificados no banco em 27/11);
 * - upsert no-op em conflito da UNIQUE projeto_id (ON DUPLICATE KEY UPDATE sem
 *   atribuição de colunas → segunda execução não duplica nem altera);
 * - projeto com linha existente não é tocado.
 */
import { describe, expect, it } from 'vitest';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { projetoMotorConfig } from '../../schema';
import {
  ensureMotorConfigPadrao,
  MOTOR_CONFIG_DEFAULTS_MONOREPO,
} from '../projeto-motor-config-defaults';

type ChamadaInsert = {
  table: unknown;
  values: Record<string, unknown>;
  dupSet?: Record<string, unknown>;
};

function criarDbFake(affectedRows: number) {
  const chamadas: ChamadaInsert[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const chamada: ChamadaInsert = { table, values: row };
        chamadas.push(chamada);
        return {
          onDuplicateKeyUpdate: (config: { set: Record<string, unknown> }) => {
            chamada.dupSet = config.set;
            return Promise.resolve([{ affectedRows }, []]);
          },
        };
      },
    }),
  };
  return { db: db as unknown as MySql2Database, chamadas };
}

describe('MOTOR_CONFIG_DEFAULTS_MONOREPO', () => {
  it('espelha a linha do projeto 1 (biblioteca-global) verificada no banco em 27/11', () => {
    expect(MOTOR_CONFIG_DEFAULTS_MONOREPO).toEqual({
      projectLayout: 'monorepo',
      repoPath: '/data/workspace/projects/codigofonte/biblioteca-global',
      branchTrabalho: 'base-desenvolvimento',
      buildCommand: 'npm ci --prefer-offline --no-audit --no-fund && npm run build',
      unitTestCommand: 'npm run test',
      unitTestExclude: ['wt-deploy/'],
      deployKind: 'blue-green-api',
      defaultMaxRework: 3,
      defaultHardTimeoutMs: 3600000,
    });
  });
});

describe('ensureMotorConfigPadrao', () => {
  it('insere projeto_id + defaults monorepo na tabela projeto_motor_config', async () => {
    const { db, chamadas } = criarDbFake(1);

    const resultado = await ensureMotorConfigPadrao(db, 16);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.table).toBe(projetoMotorConfig);
    expect(chamadas[0]!.values).toEqual({
      projetoId: 16,
      ...MOTOR_CONFIG_DEFAULTS_MONOREPO,
    });
    expect(resultado).toEqual({ inserido: true });
  });

  it('usa ON DUPLICATE KEY UPDATE no-op: única atribuição é a própria coluna UNIQUE (sem UPDATE em colunas)', async () => {
    const { db, chamadas } = criarDbFake(1);

    await ensureMotorConfigPadrao(db, 16);

    const set = chamadas[0]!.dupSet;
    expect(set).toBeDefined();
    // Nenhum literal de default é reatribuído no conflito (linha existente intocável).
    expect(Object.keys(set!)).toEqual(['projetoId']);
    // Autoatribuição da coluna (no-op canônico MySQL), não um valor literal.
    const ref = set!.projetoId as { queryChunks?: Array<{ name?: string }> };
    expect(Array.isArray(ref.queryChunks)).toBe(true);
    expect(ref.queryChunks!.some((chunk) => chunk?.name === 'projeto_id')).toBe(true);
  });

  it('é idempotente: segunda execução emite o mesmo no-op e reporta linha existente sem alterar (affectedRows=0)', async () => {
    const { db, chamadas } = criarDbFake(0);

    const primeira = await ensureMotorConfigPadrao(db, 16);
    const segunda = await ensureMotorConfigPadrao(db, 16);

    expect(primeira).toEqual({ inserido: false });
    expect(segunda).toEqual({ inserido: false });
    expect(chamadas).toHaveLength(2);
    // Em conflito, apenas o no-op roda — nenhuma coluna de config é atualizada.
    for (const chamada of chamadas) {
      expect(Object.keys(chamada.dupSet!)).toEqual(['projetoId']);
    }
  });

  it('rejeita projeto_id inválido sem tocar no banco', async () => {
    const { db, chamadas } = criarDbFake(1);

    await expect(ensureMotorConfigPadrao(db, 0)).rejects.toThrow(/projeto_id inválido/);
    await expect(ensureMotorConfigPadrao(db, -3)).rejects.toThrow(/projeto_id inválido/);
    await expect(ensureMotorConfigPadrao(db, Number.NaN)).rejects.toThrow(/projeto_id inválido/);
    expect(chamadas).toHaveLength(0);
  });
});
