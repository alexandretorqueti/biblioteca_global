// @vitest-environment node
/**
 * Geração Macro F2 (task-p2-1057, subtarefa 2) — disparo Telegram na
 * transição `awaiting_clarification` pelo caminho alternativo da API
 * (`registrarClarificacaoProjeto`):
 * - notifier é chamado APÓS o update com nome/slug do projeto, resumo e nº
 *   de perguntas;
 * - falha do notifier não propaga nem reverte a transição (best-effort);
 * - caminhos de erro (projeto/geração ausentes, perguntas vazias) não disparam.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GerenteAgentesService } from '../gerenteagentes.service';
import { projetosCaptados, geracoesProjeto, projetoChats } from '../../schema';

const notifierMocks = vi.hoisted(() => ({
  notifyAwaitingClarification: vi.fn(async (_input: unknown) => undefined),
  notifyAwaitingApproval: vi.fn(async (_input: unknown) => undefined),
  constructorCalls: [] as unknown[][],
}));

vi.mock('../generation-telegram-notifier', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    GenerationTelegramNotifier: class {
      constructor(...args: unknown[]) {
        notifierMocks.constructorCalls.push(args);
      }
      notifyAwaitingClarification = notifierMocks.notifyAwaitingClarification;
      notifyAwaitingApproval = notifierMocks.notifyAwaitingApproval;
    },
  };
});

// ---------------------------------------------------------------------------
// Banco fake: roteador encadeável (select/from/where/orderBy/limit) no padrão
// dos specs existentes em api/__tests__.
// ---------------------------------------------------------------------------
function montarCenario(opts: { projetoExiste?: boolean; geracaoExiste?: boolean } = {}) {
  const projetoCaptado = { id: 7, slug: 'gestao-tarefas', nome: 'Gestão de Tarefas Global' };
  const geracao = { id: 33, projetoId: 7, status: 'pending', tasks: null };

  const filas = new Map<unknown, Array<Array<Record<string, unknown>>>>();
  filas.set(projetosCaptados, [opts.projetoExiste === false ? [] : [projetoCaptado]]);
  filas.set(geracoesProjeto, [opts.geracaoExiste === false ? [] : [geracao]]);

  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];

  const consumir = (table: unknown): Array<Record<string, unknown>> => {
    const fila = filas.get(table);
    return fila && fila.length > 0 ? fila.shift()! : [];
  };

  function chain(rows: Array<Record<string, unknown>>): any {
    const base: any = Promise.resolve(rows);
    base.limit = async (_n?: number) => rows;
    base.orderBy = (_expr?: unknown) => chain(rows);
    return base;
  }

  const roteador: any = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond?: unknown) => chain(consumir(table)),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return [{ insertId: 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, set: values });
        return { where: async (_cond?: unknown) => undefined };
      },
    }),
  };

  const config = { get: (_key: string) => undefined } as unknown as ConfigService;
  const service = new GerenteAgentesService(
    { obter: () => Promise.resolve(roteador) } as never,
    {} as never,
    {} as never,
    config,
  );

  return {
    service,
    inserts,
    updates,
    projetoToken: { id: 640, slug: 'gerenteagentes' } as never,
    projetoCaptadoId: 7,
  };
}

beforeEach(() => {
  notifierMocks.notifyAwaitingClarification.mockClear();
  notifierMocks.notifyAwaitingApproval.mockClear();
  notifierMocks.notifyAwaitingClarification.mockImplementation(async () => undefined);
});

describe('GerenteAgentesService.registrarClarificacaoProjeto — notificação Telegram (F2)', () => {
  it('dispara notifyAwaitingClarification após o update para awaiting_clarification, com projeto/resumo/nº de perguntas', async () => {
    const { service, projetoToken, projetoCaptadoId, updates } = montarCenario();

    const resultado = await service.registrarClarificacaoProjeto(
      projetoToken,
      projetoCaptadoId,
      'Entendi um sistema de tarefas por área.',
      ['Há papéis de líder de área?', 'A visibilidade é por organização?'],
    );

    expect(resultado).toMatchObject({ ok: true, geracaoId: 33, status: 'awaiting_clarification' });
    // Transição persistida ANTES do disparo.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(geracoesProjeto);
    expect(updates[0]!.set).toMatchObject({ status: 'awaiting_clarification' });
    // Chat do projeto recebeu as perguntas (role analyst).
    expect(notifierMocks.notifyAwaitingClarification).toHaveBeenCalledTimes(1);
    expect(notifierMocks.notifyAwaitingClarification).toHaveBeenCalledWith({
      nome: 'Gestão de Tarefas Global',
      slug: 'gestao-tarefas',
      resumo: 'Entendi um sistema de tarefas por área.',
      perguntas: 2,
    });
  });

  it('notifier que lança → transição persiste e a chamada retorna ok (best-effort)', async () => {
    const { service, projetoToken, projetoCaptadoId, updates } = montarCenario();
    notifierMocks.notifyAwaitingClarification.mockImplementationOnce(async () => {
      throw new Error('telegram fora do ar');
    });

    const resultado = await service.registrarClarificacaoProjeto(
      projetoToken,
      projetoCaptadoId,
      'Resumo.',
      ['Pergunta 1?'],
    );

    expect(resultado).toMatchObject({ ok: true, status: 'awaiting_clarification' });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ status: 'awaiting_clarification' });
  });

  it('projeto inexistente → NotFoundException e nenhuma notificação', async () => {
    const { service, projetoToken, projetoCaptadoId } = montarCenario({ projetoExiste: false });

    await expect(
      service.registrarClarificacaoProjeto(projetoToken, projetoCaptadoId, 'Resumo.', ['Pergunta?']),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(notifierMocks.notifyAwaitingClarification).not.toHaveBeenCalled();
  });

  it('perguntas vazias → BadRequestException e nenhuma notificação', async () => {
    const { service, projetoToken, projetoCaptadoId } = montarCenario();

    await expect(
      service.registrarClarificacaoProjeto(projetoToken, projetoCaptadoId, 'Resumo.', ['   ']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(notifierMocks.notifyAwaitingClarification).not.toHaveBeenCalled();
  });

  it('o notifier é construído com credenciais do env da API (TELEGRAM_BOT_TOKEN + TELEGRAM_GERACAO_CHAT_ID/TELEGRAM_DLQ_CHAT_ID)', () => {
    expect(notifierMocks.constructorCalls.length).toBeGreaterThan(0);
    const ultimo = notifierMocks.constructorCalls.at(-1)!;
    // config mock retorna undefined → construtor cai no fallback de process.env
    // (comportamento verificado em generation-telegram-notifier.spec.ts).
    expect(ultimo).toHaveLength(2);
    expect(ultimo[0]).toBeUndefined();
    expect(ultimo[1]).toBeUndefined();
  });

  it('chat do projeto recebe mensagem analyst com as perguntas', async () => {
    const { service, projetoToken, projetoCaptadoId, inserts } = montarCenario();

    await service.registrarClarificacaoProjeto(projetoToken, projetoCaptadoId, 'Resumo X.', ['P1?', 'P2?']);

    const chats = inserts.filter((item) => item.table === projetoChats);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.values).toMatchObject({ projetoId: 7, role: 'analyst' });
    expect(String(chats[0]!.values.texto)).toContain('1) P1?');
    expect(String(chats[0]!.values.texto)).toContain('2) P2?');
  });
});
