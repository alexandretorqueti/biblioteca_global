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

describe('GerenteAgentesController — configurações do motor', () => {
  it('lista configurações pelo contrato protegido de leitura', async () => {
    const listarConfiguracoesMotor = vi.fn().mockResolvedValue([{ chave: 'motor.max_workers', editavel: true }]);
    const instance = new GerenteAgentesController({ listarConfiguracoesMotor } as never, {} as never);

    await expect(instance.listarConfiguracoes()).resolves.toEqual([{ chave: 'motor.max_workers', editavel: true }]);
    expect(listarConfiguracoesMotor).toHaveBeenCalledOnce();
  });

  it('encaminha o mapa de valores para persistência validada', async () => {
    const atualizarConfiguracoesMotor = vi.fn().mockResolvedValue([]);
    const instance = new GerenteAgentesController({ atualizarConfiguracoesMotor } as never, {} as never);

    await instance.atualizarConfiguracoes({ valores: { 'motor.max_workers': 3 } });

    expect(atualizarConfiguracoesMotor).toHaveBeenCalledWith({ 'motor.max_workers': 3 });
  });

  it('mantém a resposta de validação do serviço para a interface', async () => {
    const erro = {
      status: 400,
      response: {
        message: 'Uma ou mais configurações são inválidas',
        erros: [{ chave: 'motor.max_workers', mensagem: 'Valor inválido', regraValidacao: 'inteiro entre 1 e 100' }],
      },
    };
    const atualizarConfiguracoesMotor = vi.fn().mockRejectedValue(erro);
    const instance = new GerenteAgentesController({ atualizarConfiguracoesMotor } as never, {} as never);

    await expect(instance.atualizarConfiguracoes({ valores: { 'motor.max_workers': 0 } })).rejects.toMatchObject(erro);
  });
});
