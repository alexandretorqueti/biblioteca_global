// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

vi.mock('../../../../apps/api/src/modules/crud/project-db.factory');
vi.mock('../../../../apps/api/src/modules/crud/schema-registry');
vi.mock('../../../../apps/api/src/modules/provision/provision.service');
vi.mock('../../../../apps/api/src/modules/realtime/realtime.service');

import { GerenteAgentesService } from '../gerenteagentes.service';
import type { ProjectDbFactory } from '../../../../apps/api/src/modules/crud/project-db.factory';
import type { SchemaRegistry } from '../../../../apps/api/src/modules/crud/schema-registry';
import type { ProvisionService } from '../../../../apps/api/src/modules/provision/provision.service';
import type { RealtimeService } from '../../../../apps/api/src/modules/realtime/realtime.service';

/**
 * Mock de banco de dados Drizzle-like para simular queries encadeadas.
 * Cada método (select/from/where/orderBy/limit) retorna o próprio builder
 * para permitir encadeamento, e o resultado final é controlado via `resultados`.
 */
interface MockDbBuilder {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

function criarMockDb(): { db: MockDbBuilder & { resultados: unknown[][] }; resultados: unknown[][] } {
  const resultados: unknown[][] = [];
  let indiceResultado = 0;

  const builder: MockDbBuilder & { resultados: unknown[][] } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    resultados,
  };

  builder.select.mockReturnValue(builder);
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockImplementation(() => {
    const resultado = resultados[indiceResultado++] ?? [];
    return Promise.resolve(resultado);
  });

  return { db: builder, resultados };
}

function novoService(mockDb: MockDbBuilder & { resultados: unknown[] }): GerenteAgentesService {
  const factory = {
    obter: vi.fn().mockResolvedValue(mockDb),
  } as unknown as ProjectDbFactory;

  const registry = {} as unknown as SchemaRegistry;
  const provisionService = {} as unknown as ProvisionService;
  const configService = {
    get: (chave: string) => {
      const env: Record<string, string> = {
        MOTOR_DEV_URL: 'http://localhost:3010',
        MOTOR_VERSION: 'v2',
        MOTOR_API_PORT: '3010',
      };
      return env[chave];
    },
  } as unknown as ConfigService;
  const realtime = {} as unknown as RealtimeService;

  return new GerenteAgentesService(factory, registry, provisionService, configService, realtime);
}

describe('GerenteAgentesService.sessaoSubtarefa', () => {
  let mockDb: MockDbBuilder & { resultados: unknown[][] };
  let service: GerenteAgentesService;

  beforeEach(() => {
    const mock = criarMockDb();
    mockDb = mock.db;
    service = novoService(mockDb);
  });

  it('não lança NotFoundException quando a tarefa existe em projeto_640.tarefas, mesmo com tarefa.projetoId (projetos_captados) diferente de projeto.id (plataforma)', async () => {
    // Cenário: tarefa existe com projetoId=1 (projetos_captados.id), mas projeto.id=640 (core.projetos)
    // Antes da correção, isso lançava NotFoundException por cruzar namespaces
    mockDb.resultados.push([{ projetoId: 1 }]); // tarefa existe
    mockDb.resultados.push([{ id: 10 }]); // subtarefa existe
    mockDb.resultados.push([]); // sem sessão

    const projeto = { id: 640, key: 'gerenteagentes', nome: 'Gerente Agentes' };

    // Não deve lançar exceção
    const resultado = await service.sessaoSubtarefa(projeto as never, 123, 1);

    expect(resultado).toEqual({ available: false, messages: [], text: '' });
  });

  it('404 "Tarefa não encontrada" continua sendo lançado quando a tarefa NÃO existe', async () => {
    mockDb.resultados.push([]); // tarefa não existe

    const projeto = { id: 640, key: 'gerenteagentes', nome: 'Gerente Agentes' };

    await expect(service.sessaoSubtarefa(projeto as never, 999, 1)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.sessaoSubtarefa(projeto as never, 999, 1)).rejects.toThrow(
      'Tarefa não encontrada',
    );
  });

  it('quando a subtarefa não tem sessão em motor_agent_sessions, resposta é { available: false, messages: [], text: "" }', async () => {
    mockDb.resultados.push([{ projetoId: 1 }]); // tarefa existe
    mockDb.resultados.push([{ id: 10 }]); // subtarefa existe
    mockDb.resultados.push([]); // sem sessão

    const projeto = { id: 640, key: 'gerenteagentes', nome: 'Gerente Agentes' };
    const resultado = await service.sessaoSubtarefa(projeto as never, 123, 1);

    expect(resultado).toEqual({
      available: false,
      messages: [],
      text: '',
    });
  });

  it('quando há sessão, resposta contém available, sessionKey, messages e text montados de motor_agent_session_messages', async () => {
    mockDb.resultados.push([{ projetoId: 1 }]); // tarefa existe
    mockDb.resultados.push([{ id: 10 }]); // subtarefa existe
    mockDb.resultados.push([{ id: 100, sessionKey: 'agent:test-session:main' }]); // sessão existe

    // Mock separado para messages (não usa limit, usa orderBy direto)
    const messagesMock = vi.fn().mockResolvedValue([
      { role: 'user', text: 'Olá, como vai?' },
      { role: 'assistant', text: 'Olá! Estou bem, obrigado.' },
    ]);
    
    // Salvar o mock original de select
    const originalSelect = mockDb.select;
    
    // Configurar select para retornar chain diferente quando chamado para messages
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        // Primeiras 3 chamadas: tarefas, subtarefas, sessions (usam chain completo com limit)
        return mockDb;
      } else {
        // 4ª chamada: messages (não usa limit, usa orderBy direto)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: messagesMock,
            }),
          }),
        };
      }
    });

    const projeto = { id: 640, key: 'gerenteagentes', nome: 'Gerente Agentes' };
    const resultado = await service.sessaoSubtarefa(projeto as never, 123, 1);

    expect(resultado.available).toBe(true);
    expect(resultado.sessionKey).toBe('agent:test-session:main');
    expect(resultado.messages).toEqual([
      { role: 'user', text: 'Olá, como vai?' },
      { role: 'assistant', text: 'Olá! Estou bem, obrigado.' },
    ]);
    expect(resultado.text).toBe('[user]\nOlá, como vai?\n\n[assistant]\nOlá! Estou bem, obrigado.');
    
    // Restaurar mock original
    mockDb.select.mockImplementation(originalSelect);
  });

  it('quando há sessão mas sem mensagens, available é false', async () => {
    mockDb.resultados.push([{ projetoId: 1 }]); // tarefa existe
    mockDb.resultados.push([{ id: 10 }]); // subtarefa existe
    mockDb.resultados.push([{ id: 100, sessionKey: 'agent:test-session:main' }]); // sessão existe

    const messagesMock = vi.fn().mockResolvedValue([]);
    
    // Salvar o mock original de select
    const originalSelect = mockDb.select;
    
    // Configurar select para retornar chain diferente quando chamado para messages
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        // Primeiras 3 chamadas: tarefas, subtarefas, sessions (usam chain completo com limit)
        return mockDb;
      } else {
        // 4ª chamada: messages (não usa limit, usa orderBy direto)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: messagesMock,
            }),
          }),
        };
      }
    });

    const projeto = { id: 640, key: 'gerenteagentes', nome: 'Gerente Agentes' };
    const resultado = await service.sessaoSubtarefa(projeto as never, 123, 1);

    expect(resultado.available).toBe(false);
    expect(resultado.sessionKey).toBe('agent:test-session:main');
    expect(resultado.messages).toEqual([]);
    expect(resultado.text).toBe('');
    
    // Restaurar mock original
    mockDb.select.mockImplementation(originalSelect);
  });
});
