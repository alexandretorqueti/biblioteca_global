// @vitest-environment node
/**
 * gerenteagentes.service.motor-config-safety-net.spec.ts — Safety net de
 * projeto_motor_config no dispararMissaoSetup + item 2.8 do checklist da
 * missão (tarefa 1138/bloqueio 3568 — fim do bloqueio "repoPath vazio").
 *
 * Critérios cobertos:
 * - projeto sem linha prévia: dispararMissaoSetup garante o registro ANTES de
 *   ler a config → repoPath lido reflete o default monorepo da raiz;
 * - linha existente (valores diferentes dos defaults): não é tocada e é a que
 *   a missão usa;
 * - checklist da missão contém o item 2.8 e o MODO VERIFICAÇÃO referencia 2.1–2.8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { MySql2Database } from 'drizzle-orm/mysql2';

import { GerenteAgentesService } from '../gerenteagentes.service';
import {
  projetoMotorConfig,
  projetosCaptados,
  tarefas,
  geracoesProjeto,
} from '../../schema';
import { MOTOR_CONFIG_DEFAULTS_MONOREPO } from '../projeto-motor-config-defaults';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_p: unknown) => false),
  readFileSync: vi.fn((_p: unknown, _enc?: unknown): string => {
    throw new Error('ENOENT');
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    default: { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync },
  };
});

const PROJETO_CAPTADO = {
  id: 16,
  slug: 'vitrine-ia',
  nome: 'Vitrine IA — Loja de Atendentes Virtuais',
  descricao: 'Loja de atendentes virtuais.',
  especificacao: 'Especificação captada pela Isa.',
  setupStatus: 'pending',
  plataformaProjetoId: 900,
  agenteId: null,
  contatoId: 5,
};

const EXECUTOR = { id: 1, slug: 'biblioteca-global', nome: 'Biblioteca Global' };

type MotorConfigRow = Record<string, unknown>;

/**
 * Filtro de select por tabela com semântica MySQL do upsert no-op:
 * INSERT em projeto_motor_config só cria quando não há linha (unique em
 * projeto_id); com linha existente, affectedRows=0 e nada muda.
 */
function criarDbFake(estado: {
  motorConfigRows: MotorConfigRow[];
  tarefasRows: Array<Record<string, unknown>>;
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
  inserts: Array<{ table: unknown; values: Record<string, unknown>; dupKeys?: string[] }>;
}) {
  const resolveRows = (table: unknown): unknown[] => {
    if (table === projetoMotorConfig) return estado.motorConfigRows;
    if (table === projetosCaptados) return [EXECUTOR];
    if (table === tarefas) return estado.tarefasRows;
    if (table === geracoesProjeto) return [];
    return [];
  };

  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    let currentTable: unknown = null;
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn((table: unknown) => {
      currentTable = table;
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(async () => resolveRows(currentTable));
    return chain;
  };

  const db = {
    select: vi.fn(() => makeChain()),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          estado.updates.push({ table, set: values });
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((row: Record<string, unknown>) => {
        const entrada = { table, values: row } as {
          table: unknown;
          values: Record<string, unknown>;
          dupKeys?: string[];
        };
        estado.inserts.push(entrada);
        return {
          $returningId: vi.fn(async () => {
            if (table === tarefas) {
              estado.tarefasRows.push({ id: 555, externalId: row.externalId });
              return [{ id: 555 }];
            }
            throw new Error(`$returningId inesperado para a tabela ${String(table)}`);
          }),
          onDuplicateKeyUpdate: vi.fn(async (config: { set: Record<string, unknown> }) => {
            entrada.dupKeys = Object.keys(config.set);
            if (table === projetoMotorConfig) {
              if (estado.motorConfigRows.length === 0) {
                estado.motorConfigRows.push({ ...MOTOR_CONFIG_DEFAULTS_MONOREPO, ...row });
                return [{ affectedRows: 1 }, []];
              }
              // Conflito na UNIQUE: o set é autoatribuição de projeto_id → nada muda.
              expect(Object.keys(config.set)).toEqual(['projetoId']);
              return [{ affectedRows: 0 }, []];
            }
            throw new Error(`onDuplicateKeyUpdate inesperado para a tabela ${String(table)}`);
          }),
        };
      }),
    })),
    execute: vi.fn(async () => [[], []]),
  };

  return db as unknown as MySql2Database;
}

function criarService(): GerenteAgentesService {
  const config = { get: (_key: string) => undefined } as unknown as ConfigService;
  const service = new GerenteAgentesService(
    { obter: () => Promise.resolve({}) } as never,
    {} as never,
    {} as never,
    config,
  );
  // O enqueue HTTP do motor não faz parte deste teste.
  (service as unknown as {
    motorRequest: (...args: unknown[]) => Promise<unknown>;
  }).motorRequest = async () => ({ ok: true, status: 201, body: '' });
  return service;
}

type ServicoPrivado = {
  dispararMissaoSetup: (
    db: MySql2Database,
    projetoCaptado: unknown,
    plataformaProjetoId: number,
  ) => Promise<{ tarefaId: number; motorId: string; nova: boolean }>;
  montarMissaoSetup: (...args: unknown[]) => string;
};

describe('dispararMissaoSetup — safety net de projeto_motor_config', () => {
  let estado: {
    motorConfigRows: MotorConfigRow[];
    tarefasRows: Array<Record<string, unknown>>;
    updates: Array<{ table: unknown; set: Record<string, unknown> }>;
    inserts: Array<{ table: unknown; values: Record<string, unknown>; dupKeys?: string[] }>;
  };
  let configsCapturadas: Array<{ repoPath: string | null; layout: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    estado = { motorConfigRows: [], tarefasRows: [], updates: [], inserts: [] };
    configsCapturadas = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function prepararServicoComCapture(): GerenteAgentesService {
    const service = criarService();
    const priv = service as unknown as ServicoPrivado;
    const original = priv.montarMissaoSetup.bind(service);
    priv.montarMissaoSetup = (...args: unknown[]) => {
      configsCapturadas.push(args[3] as { repoPath: string | null; layout: string });
      return original(...args);
    };
    return service;
  }

  it('projeto sem linha prévia → garante defaults monorepo antes do SELECT e a missão lê repoPath default', async () => {
    const db = criarDbFake(estado);
    const service = prepararServicoComCapture();

    const missao = await (service as unknown as ServicoPrivado).dispararMissaoSetup(
      db,
      PROJETO_CAPTADO,
      900,
    );

    expect(missao.nova).toBe(true);
    // Linha criada com os defaults monorepo da raiz.
    expect(estado.motorConfigRows).toHaveLength(1);
    expect(estado.motorConfigRows[0]).toMatchObject({
      projetoId: 16,
      ...MOTOR_CONFIG_DEFAULTS_MONOREPO,
    });
    // O INSERT da config veio ANTES da tarefa de setup e com upsert no-op.
    const ordemTables = estado.inserts.map((i) => i.table);
    expect(ordemTables.indexOf(projetoMotorConfig)).toBeGreaterThanOrEqual(0);
    expect(ordemTables.indexOf(projetoMotorConfig)).toBeLessThan(ordemTables.indexOf(tarefas));
    expect(estado.inserts.find((i) => i.table === projetoMotorConfig)?.dupKeys).toEqual(['projetoId']);
    // repoPath lido após o ensure reflete o default (config não-nula).
    expect(configsCapturadas[0]).toMatchObject({
      layout: 'monorepo',
      repoPath: MOTOR_CONFIG_DEFAULTS_MONOREPO.repoPath,
      branchTrabalho: MOTOR_CONFIG_DEFAULTS_MONOREPO.branchTrabalho,
    });
  });

  it('linha existente com valores diferentes dos defaults → não é tocada e é a que a missão usa', async () => {
    const EXISTENTE = {
      projetoId: 16,
      projectLayout: 'monorepo',
      repoPath: '/srv/projeto-personalizado',
      branchTrabalho: 'feature/custom',
      gitRemote: 'origin',
      buildCommand: 'make build',
      unitTestCommand: 'make test',
      unitTestExclude: [],
      deployKind: 'manual',
      defaultMaxRework: 1,
      defaultHardTimeoutMs: 60000,
    };
    estado.motorConfigRows.push({ ...EXISTENTE });
    const snapshot = JSON.stringify(EXISTENTE);

    const db = criarDbFake(estado);
    const service = prepararServicoComCapture();

    await (service as unknown as ServicoPrivado).dispararMissaoSetup(db, PROJETO_CAPTADO, 900);

    // Linha intacta (sem UPDATE, sem duplicação) e default não sobrescreve.
    expect(estado.motorConfigRows).toHaveLength(1);
    expect(JSON.stringify(estado.motorConfigRows[0])).toBe(snapshot);
    expect(estado.updates.map((u) => u.table)).not.toContain(projetoMotorConfig);
    // A missão usa a config existente, não o default.
    expect(configsCapturadas[0]).toMatchObject({
      layout: 'monorepo',
      repoPath: '/srv/projeto-personalizado',
      branchTrabalho: 'feature/custom',
      gitRemote: 'origin',
    });
  });
});

describe('montarMissaoSetup — checklist 2.8 do registro do motor', () => {
  const CONFIG_MONOREPO = {
    layout: 'monorepo' as const,
    repoPath: null,
    branchTrabalho: null,
    gitRemote: null,
  };

  function montar(service: GerenteAgentesService, estadoProjeto: unknown = null): string {
    return (service as unknown as ServicoPrivado).montarMissaoSetup(
      PROJETO_CAPTADO,
      900,
      null,
      CONFIG_MONOREPO,
      estadoProjeto,
    );
  }

  it('missão de projeto novo inclui item 2.8 com verificação/inserção de projeto_motor_config', () => {
    const missao = montar(criarService());

    expect(missao).toContain('2.8. REGISTRO DO MOTOR (banco projeto_640.projeto_motor_config)');
    expect(missao).toContain('Confirmar EXISTS linha com o projeto_id');
    expect(missao).toContain('inserir defaults monorepo espelhando o projeto 1');
    expect(missao).toContain('repo_path, branch_trabalho, build_command,');
    expect(missao).toContain('unit_test_command, unit_test_exclude, deploy_kind,');
    expect(missao).toContain('default_max_rework, default_hard_timeout_ms');
    expect(missao).toContain('NUNCA sobrescrever linha existente');
  });

  it('MODO VERIFICAÇÃO referencia 2.1–2.8 (não 2.1–2.7)', () => {
    const missao = montar(criarService(), {
      raizMonorepo: '/repo-fake',
      pastaProjeto: true,
      bancoExiste: true,
      migrationsAplicadas: true,
      projetoExiste: true,
      artefatos: [{ nome: 'pasta projects/vitrine-ia/', presente: true, detalhe: null }],
    });

    expect(missao).toContain('MODO VERIFICAÇÃO');
    expect(missao).toContain('em cada item 2.1–2.8');
    expect(missao).not.toContain('2.1–2.7');
  });
});
