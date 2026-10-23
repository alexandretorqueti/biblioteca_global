// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';

vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: vi.fn() }));

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { GerenteAgentesService } from '../gerenteagentes.service';

/** Mock de HTTP do motor que responde `body` com o statusCode informado. */
function motorHttpMock(body: unknown, statusCode = 200): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const response = {
      setEncoding: vi.fn(),
      statusCode,
      on: vi.fn((event: string, handler: (chunk?: string) => void) => {
        if (event === 'data') setImmediate(() => handler(JSON.stringify(body)));
        if (event === 'end') setImmediate(() => handler());
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(response));
    return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  });
}

function novoService(): { service: GerenteAgentesService; registrarEvento: ReturnType<typeof vi.fn> } {
  const task = { id: 1029, externalId: 'task-p2-1029', titulo: 'Verificação direta concluída' };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([task]) }) }) }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    execute: vi.fn().mockResolvedValue([[], []]),
  };
  const config = { get: (key: string) => (key === 'MOTOR_VERSION' ? 'v3' : undefined) } as unknown as ConfigService;
  const service = new GerenteAgentesService({ obter: () => Promise.resolve(db) } as never, {} as never, {} as never, config);
  const registrarEvento = vi.fn().mockResolvedValue(undefined);
  (service as unknown as { registrarEvento: unknown }).registrarEvento = registrarEvento;
  return { service, registrarEvento };
}

function instalarMock(body: unknown, statusCode = 200): void {
  vi.mocked(httpRequest).mockImplementation(motorHttpMock(body, statusCode) as never);
  vi.mocked(httpsRequest).mockImplementation(motorHttpMock(body, statusCode) as never);
}

beforeEach(() => {
  vi.mocked(httpRequest).mockReset();
  vi.mocked(httpsRequest).mockReset();
});

describe('GerenteAgentesService — cancelarTarefa com tarefa terminal (tarefa 1029)', () => {
  it('retorna estado idempotente e NÃO registra cancel_requested quando o motor indica alreadyTerminal', async () => {
    instalarMock({
      ok: true,
      accepted: false,
      alreadyTerminal: true,
      taskId: 'task-p2-1029',
      terminalStatus: 'completed',
      message: 'Tarefa já está em estado terminal (completed); nenhum comando de cancelamento foi enfileirado',
    });
    const { service, registrarEvento } = novoService();

    const result = await service.cancelarTarefa({} as never, 1029, 'usuario', 'limpar estado enganoso');

    expect(result).toMatchObject({
      id: 1029,
      cancelled: false,
      alreadyTerminal: true,
      terminalStatus: 'completed',
    });
    expect(registrarEvento).not.toHaveBeenCalled();
  });

  it('preserva o fluxo assíncrono para tarefa não terminal: comando aceito + auditoria cancel_requested', async () => {
    instalarMock({ ok: true, accepted: true, taskId: 'task-p2-1044', messageId: 'msg-1' }, 202);
    const { service, registrarEvento } = novoService();

    const result = await service.cancelarTarefa({} as never, 1044, 'usuario', 'desistência');

    expect(result).toMatchObject({ id: 1044, cancelled: true, message: 'Cancelamento solicitado ao motor' });
    expect(registrarEvento).toHaveBeenCalledOnce();
    expect(registrarEvento.mock.calls[0]?.[2]).toBe('cancel_requested');
  });

  it('mantém BadRequestException quando o motor rejeita o cancelamento', async () => {
    instalarMock({ error: 'motor indisponível' }, 500);
    const { service, registrarEvento } = novoService();

    await expect(service.cancelarTarefa({} as never, 1029, 'usuario')).rejects.toThrow(/Motor rejeitou o cancelamento/);
    expect(registrarEvento).not.toHaveBeenCalled();
  });
});
