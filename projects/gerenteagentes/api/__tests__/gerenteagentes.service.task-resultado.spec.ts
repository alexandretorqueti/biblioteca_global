// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GerenteAgentesService } from '../gerenteagentes.service';
import { NotFoundException } from '@nestjs/common';

describe('GerenteAgentesService — resultado final consolidado (ST-4)', () => {
  const projeto = { id: 640, slug: 'gerenteagentes' } as never;

  function service() {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };

    const factory = {
      obter: vi.fn().mockResolvedValue(mockDb),
    };

    const configService = {
      get: vi.fn().mockReturnValue(''),
    };

    const instance = new GerenteAgentesService(
      factory as never,
      {} as never,
      {} as never,
      configService as never,
    );

    return { instance, mockDb, factory };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna tarefa com resultadoFinal para tarefa de verificacao', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 1,
      externalId: 'task-biblioteca-1',
      projetoId: 640,
      titulo: 'Verificar integridade',
      descricao: 'Verificar integridade do banco',
      tipo: 'verificacao',
      status: 'completed',
      resultadoFinal: JSON.stringify({
        status: 'done',
        summary: 'Todas as verificações passaram',
        reason: 'Integridade confirmada',
      }),
      ultimaMensagemErro: null,
      maxRework: 3,
      hardTimeoutMs: 3600000,
      dependsOnTaskId: null,
      autoStart: false,
      planCoverage: null,
      bootRetryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 1);

    expect(result.id).toBe(1);
    expect(result.resultadoFinal).toBeDefined();
    expect(result.resultadoFinal?.status).toBe('done');
    expect(result.resultadoFinal?.summary).toBe('Todas as verificações passaram');
    expect(result.resultadoFinal?.reason).toBe('Integridade confirmada');
  });

  it('retorna resultadoFinal null para tarefa de desenvolvimento', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 2,
      titulo: 'Implementar feature',
      tipo: 'desenvolvimento',
      status: 'completed',
      resultadoFinal: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 2);

    expect(result.resultadoFinal).toBeNull();
  });

  it('retorna resultadoFinal null quando resultadoFinal é null mesmo para verificacao', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 3,
      titulo: 'Verificar integridade',
      tipo: 'verificacao',
      status: 'running',
      resultadoFinal: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 3);

    expect(result.resultadoFinal).toBeNull();
  });

  it('lança NotFoundException quando tarefa não existe', async () => {
    const { instance, mockDb } = service();

    mockDb.limit.mockResolvedValue([]);

    await expect(instance.obterTarefaComResultadoFinal(projeto, 999)).rejects.toThrow(NotFoundException);
  });

  it('retorna resultadoFinal null quando JSON é inválido', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 4,
      titulo: 'Verificar integridade',
      tipo: 'verificacao',
      status: 'completed',
      resultadoFinal: 'invalid json',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 4);

    expect(result.resultadoFinal).toBeNull();
  });

  it('retorna resultadoFinal para tarefa de automacao', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 5,
      titulo: 'Automatizar deploy',
      tipo: 'automacao',
      status: 'completed',
      resultadoFinal: JSON.stringify({
        status: 'need_help',
        summary: 'Precisa configuração adicional',
        reason: 'Faltam credenciais de deploy',
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 5);

    expect(result.resultadoFinal).toBeDefined();
    expect(result.resultadoFinal?.status).toBe('need_help');
  });

  it('retorna resultadoFinal com status blocked_environment', async () => {
    const { instance, mockDb } = service();
    const tarefaMock = {
      id: 6,
      titulo: 'Verificar ambiente',
      tipo: 'verificacao',
      status: 'blocked',
      resultadoFinal: JSON.stringify({
        status: 'blocked_environment',
        summary: 'Ambiente indisponível',
        reason: 'Banco de dados fora do ar',
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.limit.mockResolvedValue([tarefaMock]);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 6);

    expect(result.resultadoFinal).toBeDefined();
    expect(result.resultadoFinal?.status).toBe('blocked_environment');
  });
});
