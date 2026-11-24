// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';

vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: vi.fn() }));

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { GerenteAgentesService } from '../gerenteagentes.service';

function requestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const response = {
      setEncoding: vi.fn(),
      statusCode: 200,
      on: vi.fn((event: string, handler: (chunk?: string) => void) => {
        if (event === 'data') setImmediate(() => handler(JSON.stringify({ id: 'task-1', status: 'blocked' })));
        if (event === 'end') setImmediate(() => handler());
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(response));
    return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  });
}

function novoService(tarefaRow?: Record<string, unknown>): GerenteAgentesService {
  let orderedSelects = 0;
  const task = { id: 1, externalId: 'task-1', titulo: 'Tarefa', ...(tarefaRow ?? {}) };
  const subtaskRows = [
    { id: 10, seq: 1, titulo: 'Bloqueada', status: 'blocked', deliverCount: 0, resultado: null, scope: null, acceptanceCriteria: null, workspaceStatus: null, workspaceBranch: null, workspaceCommitSha: null, correctionForSubtaskId: null },
    { id: 11, seq: 2, titulo: 'Concluída', status: 'completed', deliverCount: 1, resultado: 'Entrega persistida', scope: null, acceptanceCriteria: null, workspaceStatus: null, workspaceBranch: null, workspaceCommitSha: null, correctionForSubtaskId: null },
  ];
  const blockRows = [
    { subtarefaId: 10, reason: null, command: null, exitCode: null, excerpt: 'Dependência indisponível' },
    { subtarefaId: null, reason: 'Bloqueio da tarefa não pertence à subtarefa', command: null, exitCode: null, excerpt: null },
  ];
  const sessionRows = [
    { subtarefaId: 10, id: 101, model: 'openai/gpt-5.6-terra', purpose: 'development', status: 'active', openedAt: '2026-11-24T10:00:00Z', lastActivityAt: '2026-11-24T10:20:00Z', closedAt: null },
    { subtarefaId: 11, id: 102, model: 'deepseek/deepseek-v4-flash', purpose: 'development', status: 'failed', openedAt: '2026-11-24T08:00:00Z', lastActivityAt: '2026-11-24T08:30:00Z', closedAt: '2026-11-24T08:31:00Z' },
    { subtarefaId: 11, id: 103, model: 'ollama/qwen3.8:27b-mtp-q8_0', purpose: 'development', status: 'completed', openedAt: '2026-11-24T07:00:00Z', lastActivityAt: '2026-11-24T07:40:00Z', closedAt: '2026-11-24T07:41:00Z' },
  ];
  const db = {
    select: () => ({ from: () => ({ where: () => ({
      limit: () => Promise.resolve([task]),
      orderBy: () => { const n = ++orderedSelects; return Promise.resolve(n === 1 ? subtaskRows : n === 2 ? blockRows : sessionRows); },
    }) }) }),
    execute: vi.fn().mockResolvedValue([[], []]),
  };
  const config = { get: (key: string) => key === 'MOTOR_VERSION' ? 'v3' : undefined } as unknown as ConfigService;
  return new GerenteAgentesService({ obter: () => Promise.resolve(db) } as never, {} as never, {} as never, config);
}

beforeEach(() => {
  vi.mocked(httpRequest).mockReset();
  vi.mocked(httpsRequest).mockReset();
  vi.mocked(httpRequest).mockImplementation(requestMock() as never);
  vi.mocked(httpsRequest).mockImplementation(requestMock() as never);
});

describe('GerenteAgentesService — motor-detail', () => {
  it('expõe resultado e bloqueio ativo apenas para a subtarefa correspondente', async () => {
    const detail = await novoService().motorDetailTarefa({} as never, 1);

    expect(detail.subtasks?.[0]).toMatchObject({
      id: 10,
      blockInfo: { reason: 'Dependência indisponível' },
      resultado: null,
    });
    expect(detail.subtasks?.[1]).toMatchObject({
      id: 11,
      blockInfo: null,
      resultado: 'Entrega persistida',
    });
  });

  it('expõe a descrição persistida em tarefas.descricao no objeto task da resposta', async () => {
    const detail = await novoService({ descricao: 'Descrição persistida da tarefa' }).motorDetailTarefa({} as never, 1);

    expect(detail.task).toMatchObject({ descricao: 'Descrição persistida da tarefa' });
  });

  it('expõe descricao null quando a tarefa não tem descrição persistida', async () => {
    const detail = await novoService({ descricao: null }).motorDetailTarefa({} as never, 1);

    expect(detail.task).toMatchObject({ descricao: null });
  });

  it('enriquece cada subtarefa com currentModel (sessão ativa) e modelHistory (mais recente primeiro)', async () => {
    const detail = await novoService().motorDetailTarefa({} as never, 1);

    // Subtarefa 10 tem uma sessão ativa → currentModel preenchido.
    expect(detail.subtasks?.[0]).toMatchObject({
      currentModel: 'openai/gpt-5.6-terra',
      modelHistory: [{
        id: 101,
        model: 'openai/gpt-5.6-terra',
        purpose: 'development',
        status: 'active',
        openedAt: '2026-11-24T10:00:00Z',
        closedAt: null,
      }],
    });
    // Subtarefa 11 só tem sessões encerradas → currentModel null e histórico completo.
    expect(detail.subtasks?.[1]).toMatchObject({ currentModel: null });
    expect(detail.subtasks?.[1]?.modelHistory).toEqual([
      expect.objectContaining({ id: 102, model: 'deepseek/deepseek-v4-flash', status: 'failed' }),
      expect.objectContaining({ id: 103, model: 'ollama/qwen3.8:27b-mtp-q8_0', status: 'completed' }),
    ]);
  });
});
