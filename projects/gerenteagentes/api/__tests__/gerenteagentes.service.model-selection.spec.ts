// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { IncomingMessage } from "node:http";

vi.mock("node:https", () => ({
  request: vi.fn(),
}));
vi.mock("node:http", () => ({
  request: vi.fn(),
}));

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { GerenteAgentesService } from "../gerenteagentes.service";

/**
 * Mock de transporte estilo EventEmitter (mesmo padrão do spec
 * modelos-console): captura options e dispara o callback com resposta
 * simulada.
 *
 * Fix 2026-08-24: o proxy encaminhava o slug do projeto LOGADO no lugar do
 * `:projectKey` da rota — qualquer projeto retornava a mesma fila. Estes
 * testes garantem que o projectKey da rota é repassado ao motor tal qual.
 */
interface RespostaSimulada {
  status: number;
  body?: string;
}

interface Captura {
  options: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

let capturas: Captura[] = [];
let respostas: RespostaSimulada[] = [];
let proximaResposta = 0;

function montarRequestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const headers = {
      ...((_options.headers ?? {}) as Record<string, string | string[] | undefined>),
    };
    const chunks: string[] = [];
    const request = {
      on: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const captura: Captura = { options: _options, headers };
    capturas.push(captura);

    const proxima = respostas[Math.min(proximaResposta++, respostas.length - 1)] ?? respostas[0];
    const resposta: RespostaSimulada = proxima ?? { status: 200, body: "{}" };
    const res = {
      setEncoding: vi.fn(),
      statusCode: resposta.status,
      on: vi.fn((evento: string, handler: (chunk?: string) => void) => {
        if (evento === "data") {
          setImmediate(() => handler(resposta.body ?? ""));
        } else if (evento === "end") {
          captura.body = chunks.join("");
          setImmediate(() => handler());
        }
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(res));
    return request;
  });
}

function novoService(env: Record<string, string> = {}): { service: GerenteAgentesService } {
  const configService = {
    get: (chave: string) => env[chave],
  } as unknown as ConfigService;
  return {
    service: new GerenteAgentesService({} as never, {} as never, {} as never, configService),
  };
}

beforeEach(() => {
  vi.mocked(httpsRequest).mockReset();
  vi.mocked(httpRequest).mockReset();
  capturas = [];
  respostas = [];
  proximaResposta = 0;
  vi.mocked(httpsRequest).mockImplementation(montarRequestMock() as never);
  vi.mocked(httpRequest).mockImplementation(montarRequestMock() as never);
});

describe("GerenteAgentesService — model-selection (proxy p/ motor)", () => {
  const configuracaoGlobal = {
    DEV: [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }],
    ANALYST: [{ ordem: 1, provider: "openai", model: "gpt-5", enabled: true }],
    MONITOR: [{ ordem: 1, provider: "anthropic", model: "claude-sonnet", enabled: false }],
  };

  it("GET global usa o endpoint global e preserva a configuração", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({ status: 200, body: JSON.stringify({ ok: true, configuracaoGlobal }) });

    const resultado = await service.getGlobalModelSelection();

    expect(resultado.configuracaoGlobal).toEqual(configuracaoGlobal);
    expect(capturas[0]?.options.path).toBe("/api/model-selection/global");
  });

  it("PUT global encaminha o payload completo sem projectKey e preserva falha parcial", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({
      status: 200,
      body: JSON.stringify({
        ok: true,
        configuracaoGlobal,
        resultadoPropagacao: { sucesso: false, totalProjetos: 2 },
        projetosAplicados: [{ projectKey: "alpha", tipos: ["DEV", "ANALYST", "MONITOR"] }],
        errosPorProjeto: [{ projectKey: "beta", error: "database indisponível" }],
      }),
    });

    const resultado = await service.saveGlobalModelSelection(configuracaoGlobal);
    const chamada = capturas[0];
    if (!chamada) throw new Error("captura ausente");

    expect(chamada.options.method).toBe("PUT");
    expect(chamada.options.path).toBe("/api/model-selection/global");
    expect(JSON.parse(chamada.body ?? "{}")).toEqual(configuracaoGlobal);
    expect(resultado.errosPorProjeto).toHaveLength(1);
    expect(resultado.mensagem).toMatch(/falhou em 1 projeto/);
  });

  it("PUT global rejeita payload inválido antes de chamar o Motor", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await expect(service.saveGlobalModelSelection({ DEV: [] })).rejects.toThrow(/Configuração global inválida/);
    expect(capturas).toHaveLength(0);
  });

  it("GET repassa ao motor o projectKey da rota (não o do projeto logado)", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({
      status: 200,
      body: JSON.stringify({
        projectKey: "biblioteca-global",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }],
      }),
    });

    const resultado = await service.getModelSelection("biblioteca-global", "DEV");

    expect(resultado.projectKey).toBe("biblioteca-global");
    expect(resultado.entries).toHaveLength(1);
    const chamada = capturas[0];
    if (!chamada) throw new Error("captura ausente");
    expect(chamada.options.path).toBe("/api/model-selection/biblioteca-global/DEV");
    expect(chamada.options.timeout).toBe(180_000);
  });

  it("aceita timeout do motor configurável por ambiente", async () => {
    const { service } = novoService({
      MOTOR_DEV_URL: "http://motor.test:6282",
      MOTOR_REQUEST_TIMEOUT_MS: "180000",
    });
    respostas.push({
      status: 200,
      body: JSON.stringify({ projectKey: "biblioteca-global", tipo: "DEV", entries: [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }] }),
    });

    await service.getModelSelection("biblioteca-global", "DEV");

    expect(capturas[0]?.options.timeout).toBe(180_000);
  });

  it("GET 404 do motor (sem seleção) → entries vazio com o projectKey pedido", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({ status: 404, body: "{}" });

    const resultado = await service.getModelSelection("biblioteca-global", "DEV");

    expect(resultado).toEqual({ projectKey: "biblioteca-global", tipo: "DEV", entries: [] });
  });

  it("PUT usa o projectKey da rota no caminho E no schema validado", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({
      status: 200,
      body: JSON.stringify({
        projectKey: "biblioteca-global",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true }],
      }),
    });

    const resultado = await service.saveModelSelection("biblioteca-global", "DEV", [
      { ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true },
    ]);

    expect(resultado.projectKey).toBe("biblioteca-global");
    const chamada = capturas[0];
    if (!chamada) throw new Error("captura ausente");
    expect(chamada.options.method).toBe("PUT");
    expect(chamada.options.path).toBe("/api/model-selection/biblioteca-global/DEV");
  });

  it("mantém PUT individual isolado do endpoint global após aplicação global", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    respostas.push({
      status: 200,
      body: JSON.stringify({
        projectKey: "biblioteca-global",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "openai", model: "gpt-5", enabled: false }],
      }),
    });

    await service.saveModelSelection("biblioteca-global", "DEV", [
      { ordem: 1, provider: "openai", model: "gpt-5", enabled: false },
    ]);

    expect(capturas).toHaveLength(1);
    expect(capturas[0]?.options.path).toBe("/api/model-selection/biblioteca-global/DEV");
    expect(capturas[0]?.options.method).toBe("PUT");
    expect(JSON.parse(capturas[0]?.body ?? "{}")).toEqual({
      entries: [{ ordem: 1, provider: "openai", model: "gpt-5", enabled: false }],
    });
    expect(capturas.some(({ options }) => options.path === "/api/model-selection/global")).toBe(false);
  });

  it("PUT com entries vazio → erro de validação do contrato shared", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await expect(
      service.saveModelSelection("biblioteca-global", "DEV", []),
    ).rejects.toBeDefined();
    // Nada foi enviado ao motor
    expect(capturas).toHaveLength(0);
  });

  it("motor fora do ar → BadRequestException com mensagem clara", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });
    vi.mocked(httpRequest).mockImplementation(() => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(service.getModelSelection("biblioteca-global", "DEV")).rejects.toThrow(
      /Motor indisponível/,
    );
  });
});
