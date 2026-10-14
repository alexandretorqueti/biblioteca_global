// @vitest-environment node
/**
 * Tarefa 993 — o evento `task.created` publicado no outbox realtime deve
 * carregar a descrição da tarefa recém-criada, para que o WebSocket do Mapa
 * de agentes popule `Task.descricao` sem depender de recarga da página.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { GerenteAgentesService } from '../gerenteagentes.service';
import {
  tarefas,
  realtimeEventOutbox,
} from '../../schema';

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

function serviceComCaptura(managedProjectOverride?: Record<string, unknown>) {
  const inserts: InsertCall[] = [];
  const managedProject = {
    id: 2,
    slug: 'projeto-x',
    ativo: true,
    agenteId: 'agente-x',
    ...managedProjectOverride,
  };

  // Linha retornada após o insert: reflete o trim persistido em tarefas.descricao.
  const linhaTarefaCriada = (descricao: string | null) => ({
    id: 77,
    externalId: 'task-p2-77',
    projetoId: 2,
    titulo: 'Tarefa nova',
    descricao,
    tipo: 'desenvolvimento',
    status: 'planned',
    pausedAt: new Date(),
  });

  let insertedDescricao: string | null = 'não-inserida';

  const tx = {
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        if (table === tarefas) {
          insertedDescricao = (values.descricao as string | null) ?? null;
          return [{ insertId: 77 }];
        }
        return [{ insertId: 1 }];
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [linhaTarefaCriada(insertedDescricao)],
        }),
      }),
    }),
  };

  const db = {
    ...tx,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [managedProject],
        }),
      }),
    }),
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const config = { get: (key: string) => (key === 'MOTOR_VERSION' ? 'v3' : undefined) } as unknown as ConfigService;
  const service = new GerenteAgentesService(
    { obter: () => Promise.resolve(db) } as never,
    {} as never,
    {} as never,
    config,
  );
  return { service, inserts };
}

function eventoTaskCreated(inserts: InsertCall[]) {
  const call = inserts.find(item => item.table === realtimeEventOutbox);
  expect(call, 'outbox realtime deve receber o evento task.created').toBeDefined();
  expect(call!.values.type).toBe('task.created');
  return call!.values.payload as Record<string, unknown>;
}

describe('GerenteAgentesService.criarTarefa — payload do evento task.created', () => {
  it('inclui a descrição persistida no payload publicado no outbox realtime', async () => {
    const { service, inserts } = serviceComCaptura();
    await service.criarTarefa({ id: 640, slug: 'gerenteagentes' } as never, {
      managedProjectId: 2,
      titulo: 'Tarefa nova',
      descricao: '  Preenchi a descrição no formulário  ',
    });

    const payload = eventoTaskCreated(inserts);
    expect(payload).toMatchObject({
      title: 'Tarefa nova',
      descricao: 'Preenchi a descrição no formulário',
      status: 'draft',
      managedProjectId: 2,
    });
  });

  it('inclui descricao null quando a tarefa é criada sem descrição', async () => {
    const { service, inserts } = serviceComCaptura();
    await service.criarTarefa({ id: 640, slug: 'gerenteagentes' } as never, {
      managedProjectId: 2,
      titulo: 'Tarefa nova',
      descricao: null,
    });

    const payload = eventoTaskCreated(inserts);
    expect(payload).toHaveProperty('descricao', null);
  });
});
