// @vitest-environment node
/**
 * isa-chat.finalize-motor-config.spec.ts — Registro automático de
 * projeto_motor_config no finalizeOnboarding (tarefa 1138/bloqueio 3568 —
 * fim do bloqueio "repoPath vazio" para projetos captados pela Isa).
 *
 * Critérios cobertos:
 * - finalização de projeto sem config gera a linha com defaults monorepo;
 * - upsert no-op em conflito (linha existente não é tocada; sem UPDATE na tabela);
 * - falha no registro do motor não aborta a captação (safety net do setup cobre).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { IsaChatService } from '../isa-chat/isa-chat.service';
import {
  projetoMotorConfig,
  projetosCaptados,
  definicoes,
  chats,
} from '../../schema';
import { MOTOR_CONFIG_DEFAULTS_MONOREPO } from '../projeto-motor-config-defaults';

vi.mock('@biblioteca-global/file-extract', () => ({
  extractTextFromFile: vi.fn().mockResolvedValue({ ok: true, text: 'texto', kind: 'text' }),
}));

const chatVerificado = {
  id: 42,
  contatoId: 5,
  projetoId: null,
  nomeProjeto: 'Vitrine IA',
  chatKey: 'nav-abc',
  sessionKey: null,
  status: 'verificado',
};

const DEFINICOES = [{ texto: 'Definição 1' }, { texto: 'Definição 2' }];

type DbRegistros = {
  inserts: Array<{ table: unknown; values?: Record<string, unknown>; dupKeys?: string[] }>;
  updates: unknown[];
};

/**
 * Mock de db com insert ciente da tabela (semântica MySQL do no-op upsert) e
 * fila de resultados para select(...).limit(n).
 */
function criarDb(registros: DbRegistros, opts: { motorInsertFalha?: boolean; affectedRows?: number } = {}) {
  const limitResults: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.limit = vi.fn(async () => limitResults.shift() ?? []);
  chain.update = vi.fn((table: unknown) => {
    registros.updates.push(table);
    return { set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) };
  });
  chain.insert = vi.fn((table: unknown) => {
    const entrada: DbRegistros['inserts'][number] = { table };
    registros.inserts.push(entrada);
    return {
      values: vi.fn((row: Record<string, unknown>) => {
        entrada.values = row;
        return {
          $returningId: vi.fn(async () => [{ id: 16 }]),
          onDuplicateKeyUpdate: vi.fn(async (config: { set: Record<string, unknown> }) => {
            entrada.dupKeys = Object.keys(config.set);
            if (opts.motorInsertFalha && table === projetoMotorConfig) {
              throw new Error('ER_DUP_ENTRY inesperado / db fora do ar');
            }
            return [{ affectedRows: opts.affectedRows ?? 1 }, []];
          }),
        };
      }),
    };
  });

  const db = chain as unknown as MySql2Database & Record<string, unknown>;
  return { db, enqueue: (rows: unknown[]) => limitResults.push(rows) };
}

function criarService(db: MySql2Database) {
  const factory = { obter: vi.fn(async () => db) };
  const bridge = { isConfigured: vi.fn(() => false) };
  const configService = {
    get: vi.fn((key: string) => {
      const env: Record<string, string> = { ISA_PROJECT_ID: '640', ISA_AGENT_ID: 'isa' };
      return env[key];
    }),
  };
  return new IsaChatService(factory as never, bridge as never, configService as never);
}

describe('finalizeOnboarding — registro automático em projeto_motor_config', () => {
  let registros: DbRegistros;
  beforeEach(() => {
    registros = { inserts: [], updates: [] };
  });

  it('projeto novo sem config → linha inserida com defaults monorepo e upsert no-op', async () => {
    const { db, enqueue } = criarDb(registros);
    // Ordem das consultas de limit: findChat → buffer → checagem de slug → agentes.
    enqueue([chatVerificado]);
    enqueue(DEFINICOES);
    enqueue([]); // slug sem colisão
    enqueue([]); // agente 'biblioteca-global' ausente (null-safe)

    const service = criarService(db);
    const result = await service.finalizeOnboarding('42', 'Descrição da Isa');

    expect(result.ok).toBe(true);

    const motorInsert = registros.inserts.find((i) => i.table === projetoMotorConfig);
    expect(motorInsert).toBeDefined();
    expect(motorInsert!.values).toEqual({
      projetoId: 16,
      ...MOTOR_CONFIG_DEFAULTS_MONOREPO,
    });
    // Conflito de UNIQUE = no-op: única "atribuição" é a própria chave única.
    expect(motorInsert!.dupKeys).toEqual(['projetoId']);
    // A tabela de config nunca é alvo de UPDATE neste fluxo.
    expect(registros.updates).not.toContain(projetoMotorConfig);
  });

  it('linha de config já existente (affectedRows=0) → finalize ok, sem duplicar e sem tocar na linha', async () => {
    const { db, enqueue } = criarDb(registros, { affectedRows: 0 });
    enqueue([chatVerificado]);
    enqueue(DEFINICOES);
    enqueue([]);
    enqueue([]);

    const service = criarService(db);
    const result = await service.finalizeOnboarding('42', 'Descrição da Isa');

    expect(result.ok).toBe(true);
    const motorInserts = registros.inserts.filter((i) => i.table === projetoMotorConfig);
    expect(motorInserts).toHaveLength(1);
    expect(motorInserts[0]!.dupKeys).toEqual(['projetoId']); // no-op em conflito
    expect(registros.updates).not.toContain(projetoMotorConfig); // linha existente intacta
  });

  it('falha no registro do motor NÃO aborta a captação (best-effort; safety net do setup)', async () => {
    const { db, enqueue } = criarDb(registros, { motorInsertFalha: true });
    enqueue([chatVerificado]);
    enqueue(DEFINICOES);
    enqueue([]);
    enqueue([]);

    const service = criarService(db);
    const result = await service.finalizeOnboarding('42', 'Descrição da Isa');

    expect(result.ok).toBe(true);
    // Fluxo seguiu: projeto criado e definições/chats vinculados.
    expect(registros.inserts.some((i) => i.table === projetosCaptados)).toBe(true);
    expect(registros.updates).toContain(definicoes);
    expect(registros.updates).toContain(chats);
  });
});
