// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GerenteAgentesController } from '../gerenteagentes.controller';

describe('GerenteAgentesController — criação de tarefa', () => {
  const projeto = { id: 640, slug: 'gerenteagentes' } as never;

  function controller() {
    const criarTarefa = vi.fn().mockResolvedValue({ id: 10 });
    const instance = new GerenteAgentesController(
      { criarTarefa } as never,
      {} as never,
    );
    return { instance, criarTarefa };
  }

  it('mapeia managedProjectId sem confundir com o id 640 do tenant', async () => {
    const { instance, criarTarefa } = controller();
    await instance.criarTarefa(projeto, {
      managedProjectId: 2,
      titulo: 'Corrigir motor',
      status: 'draft',
    });

    expect(criarTarefa).toHaveBeenCalledWith(
      projeto,
      expect.objectContaining({ managedProjectId: 2, titulo: 'Corrigir motor' }),
    );
  });

  it('aceita projeto_id legado da rota hierárquica como ID operacional', async () => {
    const { instance, criarTarefa } = controller();
    await instance.criarTarefa(projeto, {
      projeto_id: 1,
      titulo: 'Tarefa da Biblioteca',
    });

    expect(criarTarefa).toHaveBeenCalledWith(
      projeto,
      expect.objectContaining({ managedProjectId: 1 }),
    );
  });
});
