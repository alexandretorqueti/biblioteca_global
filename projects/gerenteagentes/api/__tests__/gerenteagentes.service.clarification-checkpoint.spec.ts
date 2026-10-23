// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GerenteAgentesService } from '../gerenteagentes.service';

/**
 * Retomada incremental após clarificação (task-p2-1040): quando existe
 * checkpoint de clarificação pendente, o Motor é o dono da retomada — a
 * entrega direta da mensagem na sessão do analista deve ser ignorada para
 * não concorrer com a continuação contratual na mesma sessão.
 */
describe('GerenteAgentesService — entrega direta vs checkpoint de clarificação', () => {
  let service: GerenteAgentesService;
  let mockDb: any;
  let consoleRequestSpy: ReturnType<typeof vi.spyOn>;

  function buildSelectChain(results: unknown[][]) {
    let call = 0;
    return vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation(() => Promise.resolve(results[call++] ?? [])),
        }),
      }),
    }));
  }

  beforeEach(() => {
    mockDb = {
      select: buildSelectChain([[]]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };

    service = new GerenteAgentesService(
      vi.fn().mockResolvedValue(mockDb) as any,
      {} as any,
      {} as any,
      { get: vi.fn().mockReturnValue('test') } as any,
      { publicar: vi.fn() } as any,
      undefined,
    );
    vi.spyOn(service as any, 'dbDoMotor').mockResolvedValue(mockDb);
    consoleRequestSpy = vi.spyOn(service as any, 'consoleRequest').mockResolvedValue({});
  });

  const tarefa = { id: 974, projetoId: 2, externalId: 'task-974' } as any;

  it('ignora a entrega direta e marca a entrega como cancelled quando há checkpoint pendente', async () => {
    // 1ª consulta (checkpoint pendente) retorna linha; nenhuma outra consulta acontece.
    mockDb.select = buildSelectChain([[{ id: 5 }]]);
    const setSpy = mockDb.set;

    await (service as any).entregarMensagemAoAnalista(tarefa, 453, 'Prefiro A');

    expect(consoleRequestSpy).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ estado: 'cancelled' }));
    expect(setSpy.mock.calls[0][0].erro).toContain('retomada incremental gerenciada pelo Motor');
  });

  it('sem checkpoint pendente e sem sessão do analista, não chama o Console', async () => {
    // 1ª consulta (checkpoint) vazia; 2ª (sessão do analista) vazia → retorno cedo.
    mockDb.select = buildSelectChain([[], []]);

    await (service as any).entregarMensagemAoAnalista(tarefa, 454, 'Olá');

    expect(consoleRequestSpy).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
