// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GerenteAgentesService } from '../gerenteagentes.service';
import { REALTIME_TENANT_PROJECT_ID } from '../realtime-mutation-boundary.service';

describe('GerenteAgentesService — chat da tarefa e publicação realtime', () => {
  let service: GerenteAgentesService;
  let mockDb: any;
  let mockRealtime: any;
  let mockLogger: any;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      transaction: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      $returningId: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };

    mockRealtime = {
      publicar: vi.fn(),
    };

    mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };

    const mockFactory = vi.fn().mockResolvedValue(mockDb);
    const mockRegistry = {};
    const mockProvision = {};
    const mockConfig = {
      get: vi.fn().mockReturnValue('test'),
    };

    service = new GerenteAgentesService(
      mockFactory as any,
      mockRegistry as any,
      mockProvision as any,
      mockConfig as any,
      mockRealtime,
      undefined, // gitInspector
    );

    // Mock dbDoMotor
    vi.spyOn(service as any, 'dbDoMotor').mockResolvedValue(mockDb);
  });

  it('retorna 2xx mesmo quando publicar lança exceção após commit da transação', async () => {
    const projeto = { id: 2, slug: 'gerenteagentes' };
    const tarefaId = 974;
    const texto = 'Mensagem de teste';

    // Mock da busca da tarefa
    const tarefaMock = { id: tarefaId, projetoId: 2, externalId: 'task-974' };
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          limit: vi.fn().mockResolvedValueOnce([tarefaMock]),
        }),
      }),
    });

    // Mock da transação bem-sucedida
    const mensagemCriada = { id: 453, resumeRequested: false };
    mockDb.transaction.mockImplementation(async (fn: any) => {
      // Simula a execução da transação
      return mensagemCriada;
    });

    // Mock do publicar lançando exceção
    mockRealtime.publicar.mockImplementation(() => {
      throw new Error('Evento realtime inválido');
    });

    // Mock de outras dependências
    vi.spyOn(service as any, 'entregarMensagemAoAnalista').mockResolvedValue(undefined);

    // A chamada não deve lançar exceção — o try/catch deve capturar
    const resultado = await service.adicionarMensagemChatTarefa(
      projeto as any,
      tarefaId,
      texto,
    );

    // Verifica que a mensagem foi criada e retornada (2xx)
    expect(resultado).toBeDefined();
    expect(resultado.id).toBe(453);
    expect(resultado.tarefaId).toBe(tarefaId);

    // Verifica que publicar foi chamado (e a exceção foi capturada internamente)
    expect(mockRealtime.publicar).toHaveBeenCalled();
  });

  it('publica evento task.chat.message.created quando publicar funciona normalmente', async () => {
    const projeto = { id: 2, slug: 'gerenteagentes' };
    const tarefaId = 974;
    const texto = 'Mensagem de teste';

    // Mock da busca da tarefa
    const tarefaMock = { id: tarefaId, projetoId: 2, externalId: 'task-974' };
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          limit: vi.fn().mockResolvedValueOnce([tarefaMock]),
        }),
      }),
    });

    // Mock da transação bem-sucedida
    const mensagemCriada = { id: 453, resumeRequested: false };
    mockDb.transaction.mockImplementation(async (fn: any) => {
      return mensagemCriada;
    });

    // Mock do publicar funcionando
    mockRealtime.publicar.mockImplementation(() => {});

    // Mock de outras dependências
    vi.spyOn(service as any, 'entregarMensagemAoAnalista').mockResolvedValue(undefined);

    const resultado = await service.adicionarMensagemChatTarefa(
      projeto as any,
      tarefaId,
      texto,
    );

    // Verifica que publicar foi chamado com o tipo correto e roteamento pelo tenant
    expect(mockRealtime.publicar).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.chat.message.created',
        taskId: tarefaId,
        projectId: REALTIME_TENANT_PROJECT_ID,
        payload: expect.objectContaining({
          id: 453,
          role: 'user',
          texto: 'Mensagem de teste',
          managedProjectId: 2,
        }),
      }),
    );

    expect(resultado.id).toBe(453);
  });

  it('não usa o projeto gerenciado como projectId de roteamento (padrão tenant)', async () => {
    const projeto = { id: 2, slug: 'gerenteagentes' };
    const tarefaId = 975;

    const tarefaMock = { id: tarefaId, projetoId: 2, externalId: 'task-975' };
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          limit: vi.fn().mockResolvedValueOnce([tarefaMock]),
        }),
      }),
    });

    mockDb.transaction.mockImplementation(async () => ({ id: 454, resumeRequested: false }));
    mockRealtime.publicar.mockImplementation(() => {});
    vi.spyOn(service as any, 'entregarMensagemAoAnalista').mockResolvedValue(undefined);

    await service.adicionarMensagemChatTarefa(projeto as any, tarefaId, 'Outra mensagem');

    expect(REALTIME_TENANT_PROJECT_ID).toBe(640);
    expect(mockRealtime.publicar).toHaveBeenCalledTimes(1);
    const ingress = mockRealtime.publicar.mock.calls[0]![0] as any;
    expect(ingress.projectId).toBe(640);
    expect(ingress.projectId).not.toBe(Number(tarefaMock.projetoId));
    expect(ingress.type).toBe('task.chat.message.created');
    expect(ingress.payload).toMatchObject({
      id: 454,
      tarefaId,
      role: 'user',
      managedProjectId: 2,
    });
    expect(typeof ingress.payload.createdAt).toBe('string');
  });
});
