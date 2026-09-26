// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';

vi.mock('node:https', () => ({
  request: vi.fn(),
}));
vi.mock('node:http', () => ({
  request: vi.fn(),
}));

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { GerenteAgentesService } from '../gerenteagentes.service';

/**
 * Validação do campo `subtaskCount` no endpoint tarefas-com-status.
 *
 * Critérios:
 * - Endpoint retorna `subtaskCount` para cada tarefa
 * - `subtaskCount` é 0 quando a tarefa não possui subtarefas
 * - `subtaskCount` reflete a quantidade real de subtarefas quando existentes
 */

interface Captura {
  options: Record<string, unknown>;
  body: string;
}

let capturas: Captura[] = [];
let responseBody = '{}';
let responseStatus = 200;

function montarRequestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const request = {
      on: vi.fn(),
      write: vi.fn((chunk: string) => {
        capturas.push({ options: _options, body: chunk });
      }),
      end: vi.fn((chunk?: string) => {
        if (chunk) capturas.push({ options: _options, body: chunk });
      }),
      destroy: vi.fn(),
    };

    const res = {
      setEncoding: vi.fn(),
      statusCode: responseStatus,
      on: vi.fn((evento: string, handler: (chunk?: string) => void) => {
        if (evento === 'data') {
          setImmediate(() => handler(responseBody));
        } else if (evento === 'end') {
          setImmediate(() => handler());
        }
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(res));
    return request;
  });
}

function novoService(env: Record<string, string> = {}): { service: GerenteAgentesService } {
  const configService = {
    get: (chave: string) => env[chave],
  } as unknown as ConfigService;

  // Mock do factory de banco — retorna um drizzle-like com select() que devolve tarefas fake
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              { id: 1, externalId: 'task-1', titulo: 'Tarefa com subtarefas', status: 'running' },
              { id: 2, externalId: 'task-2', titulo: 'Tarefa sem subtarefas', status: 'paused' },
              { id: 3, externalId: 'task-3', titulo: 'Tarefa fallback (motor offline)', status: 'pending' },
            ]),
        }),
      }),
    }),
  };

  const factory = {
    obter: () => Promise.resolve(fakeDb),
  };

  return {
    service: new GerenteAgentesService(
      factory as never,
      {} as never,
      {} as never,
      configService,
    ),
  };
}

beforeEach(() => {
  vi.mocked(httpsRequest).mockReset();
  vi.mocked(httpRequest).mockReset();
  capturas = [];
  responseBody = '{}';
  responseStatus = 200;
  vi.mocked(httpsRequest).mockImplementation(montarRequestMock() as never);
  vi.mocked(httpRequest).mockImplementation(montarRequestMock() as never);
});

describe('GerenteAgentesService — subtaskCount em tarefas-com-status', () => {
  it('retorna subtaskCount = 0 quando a tarefa não possui subtarefas', async () => {
    // Motor retorna tarefa sem array de subtasks
    responseBody = JSON.stringify({ status: 'paused' });
    const { service } = novoService({ MOTOR_VERSION: 'v2', MOTOR_API_PORT: '3010' });

    const resultado = await service.listarTarefasComStatusCalculado(
      { id: 640, slug: 'gerenteagentes' } as never,
    );

    const tarefaSemSubtarefas = resultado.find((t) => t.id === 2);
    expect(tarefaSemSubtarefas).toBeDefined();
    expect(tarefaSemSubtarefas?.subtaskCount).toBe(0);
  });

  it('retorna subtaskCount com a quantidade real de subtarefas', async () => {
    // Motor retorna tarefa com 3 subtarefas
    responseBody = JSON.stringify({
      status: 'running',
      subtasks: [
        { seq: 1, status: 'done' },
        { seq: 2, status: 'running' },
        { seq: 3, status: 'pending' },
      ],
    });
    const { service } = novoService({ MOTOR_VERSION: 'v2', MOTOR_API_PORT: '3010' });

    const resultado = await service.listarTarefasComStatusCalculado(
      { id: 640, slug: 'gerenteagentes' } as never,
    );

    const tarefaComSubtarefas = resultado.find((t) => t.id === 1);
    expect(tarefaComSubtarefas).toBeDefined();
    expect(tarefaComSubtarefas?.subtaskCount).toBe(3);
  });

  it('retorna subtaskCount = 0 quando o motor falha (fallback)', async () => {
    // Simula falha no motor (response não-ok)
    responseStatus = 500;
    responseBody = 'Internal Server Error';
    const { service } = novoService({ MOTOR_VERSION: 'v2', MOTOR_API_PORT: '3010' });

    const resultado = await service.listarTarefasComStatusCalculado(
      { id: 640, slug: 'gerenteagentes' } as never,
    );

    // Todas as tarefas devem ter subtaskCount = 0 no fallback
    for (const tarefa of resultado) {
      expect(tarefa.subtaskCount).toBe(0);
    }
  });

  it('retorna subtaskCount = 0 quando subtasks é null/undefined no motor', async () => {
    responseBody = JSON.stringify({ status: 'pending', subtasks: null });
    const { service } = novoService({ MOTOR_VERSION: 'v2', MOTOR_API_PORT: '3010' });

    const resultado = await service.listarTarefasComStatusCalculado(
      { id: 640, slug: 'gerenteagentes' } as never,
    );

    const tarefa = resultado.find((t) => t.id === 1);
    expect(tarefa?.subtaskCount).toBe(0);
  });
});
