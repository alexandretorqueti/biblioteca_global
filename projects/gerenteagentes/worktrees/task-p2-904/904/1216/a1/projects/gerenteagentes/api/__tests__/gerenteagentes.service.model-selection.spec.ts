// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { GerenteAgentesService } from "../gerenteagentes.service";

type ModelSelectionRow = {
  ordem: number | string;
  provider: string;
  model: string;
  enabled: number | boolean;
};

let rows: ModelSelectionRow[] = [];
let transactionExecute = vi.fn();
let execute = vi.fn();
let obter = vi.fn();

function novoService(): { service: GerenteAgentesService } {
  const configService = {
    get: () => undefined,
  } as unknown as ConfigService;
  const db = {
    execute,
    transaction: vi.fn(async (callback: (tx: { execute: typeof transactionExecute }) => Promise<void>) => {
      await callback({ execute: transactionExecute });
    }),
  };
  obter.mockResolvedValue(db);

  return {
    service: new GerenteAgentesService(
      { obter } as never,
      {} as never,
      {} as never,
      configService,
    ),
  };
}

beforeEach(() => {
  rows = [];
  transactionExecute = vi.fn().mockResolvedValue([[], []]);
  execute = vi.fn().mockImplementation(async () => [rows, []]);
  obter = vi.fn();
});

describe("GerenteAgentesService — model-selection persistida", () => {
  it("lê a seleção do banco do motor e preserva o projectKey solicitado", async () => {
    rows = [{ ordem: "1", provider: "alibaba", model: "qwen3.7-plus", enabled: 1 }];
    const { service } = novoService();

    await expect(service.getModelSelection("biblioteca-global", "DEV")).resolves.toEqual({
      projectKey: "biblioteca-global",
      tipo: "DEV",
      entries: [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }],
    });
    expect(obter).toHaveBeenCalledWith({ id: 640 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retorna seleção vazia quando não há configuração persistida", async () => {
    const { service } = novoService();

    await expect(service.getModelSelection("biblioteca-global", "DEV")).resolves.toEqual({
      projectKey: "biblioteca-global",
      tipo: "DEV",
      entries: [],
    });
  });

  it("valida antes de abrir transação de persistência", async () => {
    const { service } = novoService();

    await expect(service.saveModelSelection("biblioteca-global", "DEV", [])).rejects.toBeDefined();
    expect(obter).not.toHaveBeenCalled();
  });

  it("persiste a seleção validada em uma única transação", async () => {
    const { service } = novoService();
    const entries = [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }];

    await expect(service.saveModelSelection("biblioteca-global", "DEV", entries)).resolves.toEqual({
      projectKey: "biblioteca-global",
      tipo: "DEV",
      entries,
    });
    expect(obter).toHaveBeenCalledWith({ id: 640 });
    expect(transactionExecute).toHaveBeenCalledTimes(2);
  });
});
