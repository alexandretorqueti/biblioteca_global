// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GerenteAgentesController } from '../gerenteagentes.controller';

describe('GerenteAgentesController — resultado final consolidado (ST-4)', () => {
  const projeto = { id: 640, slug: 'gerenteagentes' } as never;

  function controller() {
    const obterTarefaComResultadoFinal = vi.fn();
    const instance = new GerenteAgentesController(
      { obterTarefaComResultadoFinal } as never,
      {} as never,
    );
    return { instance, obterTarefaComResultadoFinal };
  }

  it('chama o serviço para obter tarefa com resultado final', async () => {
    const { instance, obterTarefaComResultadoFinal } = controller();
    const tarefaMock = {
      id: 1,
      externalId: 'task-biblioteca-1',
      projetoId: 640,
      titulo: 'Verificar integridade',
      descricao: 'Verificar integridade do banco',
      tipo: 'verificacao',
      status: 'completed',
      resultadoFinal: {
        status: 'done',
        summary: 'Todas as verificações passaram',
        reason: 'Integridade confirmada',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    obterTarefaComResultadoFinal.mockResolvedValue(tarefaMock);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 1);

    expect(obterTarefaComResultadoFinal).toHaveBeenCalledWith(projeto, 1);
    expect(result).toEqual(tarefaMock);
    expect(result.resultadoFinal).toBeDefined();
    expect(result.resultadoFinal?.status).toBe('done');
  });

  it('retorna resultadoFinal null para tarefas de desenvolvimento', async () => {
    const { instance, obterTarefaComResultadoFinal } = controller();
    const tarefaMock = {
      id: 2,
      titulo: 'Implementar feature',
      tipo: 'desenvolvimento',
      status: 'completed',
      resultadoFinal: null,
    };
    obterTarefaComResultadoFinal.mockResolvedValue(tarefaMock);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 2);

    expect(result.resultadoFinal).toBeNull();
  });

  it('retorna resultadoFinal para tarefas de automacao', async () => {
    const { instance, obterTarefaComResultadoFinal } = controller();
    const tarefaMock = {
      id: 3,
      titulo: 'Automatizar deploy',
      tipo: 'automacao',
      status: 'completed',
      resultadoFinal: {
        status: 'done',
        summary: 'Deploy automatizado com sucesso',
        reason: 'Pipeline configurado',
      },
    };
    obterTarefaComResultadoFinal.mockResolvedValue(tarefaMock);

    const result = await instance.obterTarefaComResultadoFinal(projeto, 3);

    expect(result.resultadoFinal).toBeDefined();
    expect(result.resultadoFinal?.status).toBe('done');
  });
});
