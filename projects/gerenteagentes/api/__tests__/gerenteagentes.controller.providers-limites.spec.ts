// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GerenteAgentesController } from '../gerenteagentes.controller';

describe('GerenteAgentesController — limites por provider', () => {
  function controller() {
    const listarLimitesProviders = vi.fn().mockResolvedValue([]);
    const salvarLimiteProvider = vi.fn().mockResolvedValue({ provider: 'ollama' });
    const instance = new GerenteAgentesController(
      { listarLimitesProviders, salvarLimiteProvider } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { instance, listarLimitesProviders, salvarLimiteProvider };
  }

  it('GET /providers-limites delega ao service', async () => {
    const { instance, listarLimitesProviders } = controller();
    await instance.listarProvidersLimites();
    expect(listarLimitesProviders).toHaveBeenCalledTimes(1);
  });

  it('PUT /providers-limites/:provider repassa provider e body ao service', async () => {
    const { instance, salvarLimiteProvider } = controller();
    const body = { limiteExecucaoTotal: 1, limiteAnalises: null, limiteDesenvolvimento: 2 };
    await instance.salvarProviderLimite('ollama', body);
    expect(salvarLimiteProvider).toHaveBeenCalledWith('ollama', body);
  });
});
