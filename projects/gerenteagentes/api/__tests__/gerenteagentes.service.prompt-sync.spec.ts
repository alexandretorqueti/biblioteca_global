// @vitest-environment node
/**
 * Subtarefa 2 — `sincronizarCatalogoPrompts` deve detectar a mudança do
 * texto do catálogo (comparação contra `prompts_agentes.conteudo`, o
 * conteúdo de catálogo registrado) e, quando difere, gravar NOVA versão em
 * `prompts_versoes` (com validação) e apontar versaoAtivaId/status active —
 * sem sobrescrever edições manuais de outras chaves/versões.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { GerenteAgentesService } from '../gerenteagentes.service';
import { AGENT_PROMPT_CATALOG, type AgentPromptCatalogEntry } from '../../src/prompts/prompt-catalog';
import { promptsAgentes, promptsVersoes, promptsMascaras, promptsContratos, promptsContratosVersoes } from '../../schema';

type Row = Record<string, unknown> & { insertId?: number };

interface CapturedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

interface CapturedUpdate {
  table: unknown;
  set: Record<string, unknown>;
}

function dbMock(options: {
  promptsAgentesRows: Row[];
  promptsVersoesRows: Row[];
  promptsMascarasRows?: Row[];
  promptsContratosRows?: Row[];
  promptsContratosVersoesRows?: Row[];
  /** Se true, o mock de select ignora a chave e retorna TODAS as linhas (simula ausência de WHERE no mock). */
  matchByKey?: boolean;
}) {
  const inserts: CapturedInsert[] = [];
  const updates: CapturedUpdate[] = [];

  function findRows(table: unknown, cond: unknown): Row[] {
    if (table === promptsAgentes) {
      if (cond && typeof cond === 'object') {
        const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            const c = chunk as { value?: unknown } | null;
            if (c && typeof c === 'object' && typeof c.value === 'string' && c.value.length > 0 && !c.value.includes(' ')) {
              return options.promptsAgentesRows.filter((r) => r.chave === c.value);
            }
          }
        }
      }
      return options.promptsAgentesRows;
    }
    if (table === promptsVersoes) {
      if (cond && typeof cond === 'object') {
        const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            const c = chunk as { value?: unknown } | null;
            if (c && typeof c === 'object' && typeof c.value === 'string' && /^\d+$/.test(c.value)) {
              const pid = Number(c.value);
              return options.promptsVersoesRows.filter((r) => r.promptId === pid);
            }
          }
        }
      }
      return options.promptsVersoesRows;
    }
    if (table === promptsMascaras) return options.promptsMascarasRows ?? [];
    if (table === promptsContratos) return options.promptsContratosRows ?? [];
    if (table === promptsContratosVersoes) return options.promptsContratosVersoesRows ?? [];
    return [];
  }

  function whereChain(table: unknown, cond: unknown) {
    return {
      limit: async () => findRows(table, cond),
      orderBy: async () => findRows(table, cond),
    };
  }

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => whereChain(table, cond),
        orderBy: () => {
          if (table === promptsAgentes) return { limit: async () => options.promptsAgentesRows };
          if (table === promptsVersoes) return { limit: async () => options.promptsVersoesRows };
          return { limit: async () => [] };
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return Promise.resolve([{ insertId: 99 }]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return { where: async () => undefined };
      },
    })),
  };
  return { db, inserts, updates };
}

function serviceComDb(db: unknown) {
  const config = { get: (key: string) => (key === 'MOTOR_VERSION' ? 'v3' : undefined) } as unknown as ConfigService;
  return new GerenteAgentesService(
    { obter: () => Promise.resolve(db) } as never,
    {} as never,
    {} as never,
    config,
  );
}

async function sincronizar(service: GerenteAgentesService) {
  return (service as unknown as { sincronizarCatalogoPrompts(): Promise<void> }).sincronizarCatalogoPrompts();
}

describe('GerenteAgentesService.sincronizarCatalogoPrompts — detecção de mudança do catálogo', () => {
  it('cria nova versão ativa quando o texto do catálogo difere do conteúdo registrado', async () => {
    const entrada = AGENT_PROMPT_CATALOG.find((e) => e.key === 'biblioteca-global.helpdesk_atendimento');
    expect(entrada).toBeDefined();
    // Conteúdo persistido ANTES da mudança (texto antigo, sem regra de contrato).
    const linhaAntiga: Row = {
      id: 5,
      chave: 'biblioteca-global.helpdesk_atendimento',
      conteudo: 'texto antigo sem regra 9',
      versaoAtivaId: 1,
      status: 'active',
    };
    const { db, inserts, updates } = dbMock({
      promptsAgentesRows: [linhaAntiga],
      promptsVersoesRows: [{ id: 1, promptId: 5, versao: 1 }],
    });
    const service = serviceComDb(db);

    await sincronizar(service);

    const insertVersao = inserts.find((i) => i.table === promptsVersoes);
    expect(insertVersao).toBeDefined();
    expect(insertVersao!.values.promptId).toBe(5);
    expect(insertVersao!.values.versao).toBe(2);
    expect(insertVersao!.values.texto).toBe(entrada!.prompt);
    expect(insertVersao!.values.autor).toBe('sistema');
    expect(insertVersao!.values.validacao).toMatchObject({ ok: true });

    const updatePrompt = updates.find((u) => u.table === promptsAgentes);
    expect(updatePrompt).toBeDefined();
    expect(updatePrompt!.set.conteudo).toBe(entrada!.prompt);
    expect(updatePrompt!.set.versaoAtivaId).toBe(99);
    expect(updatePrompt!.set.status).toBe('active');
  });

  it('NÃO re-cria versão para a CHAVE helpdesk quando o conteúdo registrado já é igual ao catálogo (idempotente)', async () => {
    const entrada = AGENT_PROMPT_CATALOG.find((e) => e.key === 'biblioteca-global.helpdesk_atendimento');
    const linhaAtual: Row = {
      id: 5,
      chave: 'biblioteca-global.helpdesk_atendimento',
      conteudo: entrada!.prompt,
      versaoAtivaId: 3,
      status: 'active',
    };
    // As OUTRAS chaves NÃO existem no banco (simula primeiro sync) — o mock
    // matchByKey=false faz o select retornar apenas a linha helpdesk (id 5),
    // e as demais entradas do catálogo disparam o branch "existing.length === 0".
    const { db, inserts } = dbMock({
      promptsAgentesRows: [linhaAtual],
      promptsVersoesRows: [],
      matchByKey: false,
    });
    const service = serviceComDb(db);

    await sincronizar(service);

    // Nenhuma versão criada para a chave helpdesk (id 5).
    const versoesHelpdesk = inserts.filter(
      (i) => i.table === promptsVersoes && i.values.promptId === 5,
    );
    expect(versoesHelpdesk).toHaveLength(0);
  });

  it('preserva a versão ativa anterior quando o novo texto falha na validação', async () => {
    // Substitui o texto da entrada helpdesk por um com marcador não autorizado.
    const entryRef = AGENT_PROMPT_CATALOG.find((e) => e.key === 'biblioteca-global.helpdesk_atendimento') as AgentPromptCatalogEntry;
    const original = entryRef.prompt;
    // AGENT_PROMPT_CATALOG é `readonly` — usamos Object.assign para mutar o texto.
    Object.assign(entryRef, { prompt: 'texto com **MARCADOR_INVALIDO**' });

    const linha: Row = {
      id: 5,
      chave: 'biblioteca-global.helpdesk_atendimento',
      conteudo: 'texto antigo',
      versaoAtivaId: 1,
      status: 'active',
    };
    // As OUTRAS chaves NÃO existem no banco (simula primeiro sync).
    const { db, inserts, updates } = dbMock({
      promptsAgentesRows: [linha],
      promptsVersoesRows: [],
      matchByKey: false,
    });
    const service = serviceComDb(db);

    try {
      await sincronizar(service);
      // Nenhuma versão criada para a chave helpdesk (id 5) — validação falhou.
      expect(inserts.filter((i) => i.table === promptsVersoes && i.values.promptId === 5)).toHaveLength(0);
      // Nenhum update em promptsAgentes para a chave helpdesk.
      expect(updates.filter((u) => u.table === promptsAgentes && u.set.conteudo !== undefined)).toHaveLength(0);
    } finally {
      Object.assign(entryRef, { prompt: original });
    }
  });
});
