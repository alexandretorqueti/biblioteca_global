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

function novoService(): GerenteAgentesService {
  let orderedSelects = 0;
  const task = { id: 1, externalId: 'task-1', titulo: 'Tarefa' };
  const subtaskRows = [
    { id: 10, seq: 1, titulo: 'Bloqueada', status: 'blocked', deliverCount: 0, resultado: null, scope: null, acceptanceCriteria: null, workspaceStatus: null, workspaceBranch: null, workspaceCommitSha: null, correctionForSubtaskId: null },
    { id: 11, seq: 2, titulo: 'Concluída', status: 'completed', deliverCount: 1, resultado: 'Entrega persistida', scope: null, acceptanceCriteria: null, workspaceStatus: null, workspaceBranch: null, workspaceCommitSha: null, correctionForSubtaskId: null },
  ];
  const blockRows = [
    { subtarefaId: 10, reason: 'Dependência indisponível', command: null, exitCode: null, excerpt: null },
    { subtarefaId: null, reason: 'Bloqueio da tarefa não pertence à subtarefa', command: null, exitCode: null, excerpt: null },
  ];
  const db = {
    select: () => ({ from: () => ({ where: () => ({
      limit: () => Promise.resolve([task]),
      orderBy: () => Promise.resolve(++orderedSelects === 1 ? subtaskRows : blockRows),
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
});
