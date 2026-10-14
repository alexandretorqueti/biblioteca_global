// @vitest-environment node
/**
 * Contrato dos limites por provider (aba PROVIDERS da tela CONFIGURAÇÕES):
 * GET lista exatamente os providers exibidos na tela de modelos (mesma fonte
 * do service.listarModelosConsole), PUT valida faixa (1–100 ou null), rejeita
 * provider fora da fonte e persiste upsert em motor_provider_limits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { IncomingMessage } from "node:http";

vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("../../../apps/api/src/modules/crud/project-db.factory", () => ({
  PROJECT_DB_FACTORY: "PROJECT_DB_FACTORY",
}));
vi.mock("../../../apps/api/src/modules/crud/schema-registry", () => ({
  SCHEMA_REGISTRY: "SCHEMA_REGISTRY",
}));
vi.mock("../../../apps/api/src/modules/provision/provision.service", () => ({
  ProvisionService: class {},
}));
vi.mock("../../../apps/api/src/modules/realtime/realtime.service", () => ({
  RealtimeService: class {},
}));

import { request as httpsRequest } from "node:https";
import { GerenteAgentesService } from "../gerenteagentes.service";

interface RespostaSimulada {
  status: number;
  body?: string;
}

let respostas: RespostaSimulada[] = [];
let proximaResposta = 0;

function montarRequestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const request = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    const proxima = respostas[Math.min(proximaResposta++, respostas.length - 1)] ?? respostas[0];
    const resposta: RespostaSimulada = proxima ?? { status: 200, body: JSON.stringify({ models: [] }) };
    const res = {
      setEncoding: vi.fn(),
      statusCode: resposta.status,
      on: vi.fn((evento: string, handler: (chunk?: string) => void) => {
        if (evento === "data") setImmediate(() => handler(resposta.body ?? ""));
        else if (evento === "end") setImmediate(() => handler());
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(res));
    return request;
  });
}

type PersistedRow = {
  provider: string;
  limiteExecucaoTotal: number | null;
  limiteAnalises: number | null;
  limiteDesenvolvimento: number | null;
};

function novoService(opcoes: { rows?: PersistedRow[] } = {}) {
  const configService = {
    get: (chave: string) =>
      chave === "OPENCLAW_CONSOLE_URL" ? "https://console.test" : chave === "OPENCLAW_CONSOLE_TOKEN" ? "token" : undefined,
  } as unknown as ConfigService;

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn().mockResolvedValue(opcoes.rows ?? []),
  };
  const onDuplicateKeyUpdate = vi.fn().mockResolvedValue([[], []]);
  const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
  const insert = vi.fn(() => ({ values }));
  const db = {
    select: vi.fn(() => selectChain),
    insert,
  };
  const service = new GerenteAgentesService(
    { obter: vi.fn().mockResolvedValue(db) } as never,
    {} as never,
    {} as never,
    configService,
  );
  return { service, db, selectChain, values, onDuplicateKeyUpdate };
}

const MODELOS_CONSOLE = JSON.stringify({
  models: [
    { id: "m1", name: "Um", provider: "ollama" },
    { id: "m2", name: "Dois", provider: "alibaba" },
    { id: "m3", name: "Três", provider: "ollama" },
  ],
});

beforeEach(() => {
  vi.mocked(httpsRequest).mockReset();
  respostas = [{ status: 200, body: MODELOS_CONSOLE }];
  proximaResposta = 0;
  vi.mocked(httpsRequest).mockImplementation(montarRequestMock() as never);
});

describe("GerenteAgentesService.listarLimitesProviders", () => {
  it("lista um item por provider da tela de modelos, na ordem de aparição, com limites null quando não configurados", async () => {
    const { service } = novoService({
      rows: [{ provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: null, limiteDesenvolvimento: 3 }],
    });

    await expect(service.listarLimitesProviders()).resolves.toEqual([
      { provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: null, limiteDesenvolvimento: 3 },
      { provider: "alibaba", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
    ]);
  });

  it("não consulta o banco quando a fonte não tem providers", async () => {
    respostas[0] = { status: 200, body: JSON.stringify({ models: [] }) };
    const { service, db } = novoService();

    await expect(service.listarLimitesProviders()).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("console indisponível → BadRequestException com mensagem clara", async () => {
    respostas[0] = { status: 503, body: "upstream down" };
    const { service } = novoService();

    await expect(service.listarLimitesProviders()).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listarLimitesProviders()).rejects.toThrow(/Console OpenClaw indisponível \(503\)/);
  });
});

describe("GerenteAgentesService.salvarLimiteProvider", () => {
  it("persiste os três limites via upsert e devolve o valor salvo", async () => {
    const { service, values, onDuplicateKeyUpdate } = novoService();

    await expect(
      service.salvarLimiteProvider("ollama", {
        limiteExecucaoTotal: 1,
        limiteAnalises: 2,
        limiteDesenvolvimento: 3,
      }),
    ).resolves.toEqual({
      provider: "ollama",
      limiteExecucaoTotal: 1,
      limiteAnalises: 2,
      limiteDesenvolvimento: 3,
    });

    expect(values).toHaveBeenCalledWith({
      provider: "ollama",
      limiteExecucaoTotal: 1,
      limiteAnalises: 2,
      limiteDesenvolvimento: 3,
    });
    expect(onDuplicateKeyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ limiteExecucaoTotal: 1, limiteAnalises: 2, limiteDesenvolvimento: 3 }),
      }),
    );
  });

  it("aceita null em todos os campos (remove a restrição)", async () => {
    const { service, values } = novoService();

    await expect(
      service.salvarLimiteProvider("alibaba", {
        limiteExecucaoTotal: null,
        limiteAnalises: null,
        limiteDesenvolvimento: null,
      }),
    ).resolves.toEqual({
      provider: "alibaba",
      limiteExecucaoTotal: null,
      limiteAnalises: null,
      limiteDesenvolvimento: null,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null }),
    );
  });

  it.each([
    ["zero", { limiteExecucaoTotal: 0, limiteAnalises: 1, limiteDesenvolvimento: 1 }],
    ["acima de 100", { limiteExecucaoTotal: 101, limiteAnalises: 1, limiteDesenvolvimento: 1 }],
    ["não-inteiro", { limiteExecucaoTotal: 1.5, limiteAnalises: 1, limiteDesenvolvimento: 1 }],
    ["string", { limiteExecucaoTotal: "2", limiteAnalises: 1, limiteDesenvolvimento: 1 }],
    ["negativo", { limiteExecucaoTotal: -1, limiteAnalises: 1, limiteDesenvolvimento: 1 }],
  ])("rejeita %s com BadRequest claro", async (_nome, corpo) => {
    const { service } = novoService();
    await expect(service.salvarLimiteProvider("ollama", corpo)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.salvarLimiteProvider("ollama", corpo)).rejects.toThrow(/inteiro entre 1 e 100/);
  });

  it("rejeita body sem os três campos", async () => {
    const { service } = novoService();
    await expect(service.salvarLimiteProvider("ollama", { limiteExecucaoTotal: 1 })).rejects.toThrow(/Campo ausente: limiteAnalises/);
    await expect(service.salvarLimiteProvider("ollama", null)).rejects.toThrow(/Body inválido/);
  });

  it("rejeita provider fora da fonte da tela de modelos", async () => {
    const { service, db } = novoService();
    await expect(
      service.salvarLimiteProvider("openai", {
        limiteExecucaoTotal: null,
        limiteAnalises: null,
        limiteDesenvolvimento: null,
      }),
    ).rejects.toThrow(/Provider desconhecido: openai/);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
