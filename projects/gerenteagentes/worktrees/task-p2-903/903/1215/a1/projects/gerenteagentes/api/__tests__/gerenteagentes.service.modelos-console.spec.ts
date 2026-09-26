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
 * Mock de transporte estilo EventEmitter: cada chamada a `request`
 * captura as options e dispara o callback com uma resposta simulada
 * (statusCode + body). Mesma forma do service consumir `res.on('data'|'end')`.
 */
interface RespostaSimulada {
  status: number;
  body?: string;
}

interface Captura {
  options: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  request: {
    on: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

let capturas: Captura[] = [];
let respostas: RespostaSimulada[] = [];
let proximaResposta = 0;

function montarRequestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const headers = {
      ...((_options.headers ?? {}) as Record<string, string | string[] | undefined>),
    };
    const request = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    capturas.push({ options: _options, headers, request });

    const proxima = respostas[Math.min(proximaResposta++, respostas.length - 1)] ?? respostas[0];
    const resposta: RespostaSimulada =
      proxima ?? { status: 200, body: JSON.stringify({ models: [] }) };
    const res = {
      setEncoding: vi.fn(),
      statusCode: resposta.status,
      on: vi.fn((evento: string, handler: (chunk?: string) => void) => {
        if (evento === "data") {
          setImmediate(() => handler(resposta.body ?? ""));
        } else if (evento === "end") {
          setImmediate(() => handler());
        }
      }),
    } as unknown as IncomingMessage;
    setImmediate(() => callback(res));
    return request;
  });
}

function novoService(env: Record<string, string> = {}): {
  service: GerenteAgentesService;
} {
  const configService = {
    get: (chave: string) => env[chave],
  } as unknown as ConfigService;
  const service = new GerenteAgentesService(
    {} as never,
    {} as never,
    {} as never,
    configService,
  );
  return { service };
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

describe("GerenteAgentesService.listarModelosConsole", () => {
  it("normaliza {models: [...]} para [{id, name, provider}] (com alias opcional)", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "token-secreto",
    });
    respostas.push({
      status: 200,
      body: JSON.stringify({
        models: [
          { id: "m1", name: "Modelo Um", provider: "ollama", alias: "um" },
          { id: "m2", name: "Modelo Dois", provider: "openai" },
          { id: "m3", provider: "anthropic" }, // sem name → usa id
        ],
      }),
    });

    const modelos = await service.listarModelosConsole();

    expect(modelos).toEqual([
      { id: "m1", name: "Modelo Um", provider: "ollama", alias: "um" },
      { id: "m2", name: "Modelo Dois", provider: "openai" },
      { id: "m3", name: "m3", provider: "anthropic" },
    ]);
  });

  it("aceita array direto e descarta entradas sem id", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "token-secreto",
    });
    respostas.push({
      status: 200,
      body: JSON.stringify([
        { id: "m1", name: "Um", provider: "ollama" },
        { name: "sem id", provider: "x" },
      ]),
    });

    const modelos = await service.listarModelosConsole();

    expect(modelos).toEqual([{ id: "m1", name: "Um", provider: "ollama" }]);
  });

  it("erro de status upstream → BadRequestException com mensagem clara", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "token-secreto",
    });
    respostas.push({ status: 503, body: "upstream down" });

    await expect(service.listarModelosConsole()).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listarModelosConsole()).rejects.toThrow(/Console OpenClaw indisponível \(503\)/);
  });

  it("resposta inválida (não-JSON) → BadRequestException", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "token-secreto",
    });
    respostas.push({ status: 200, body: "isso não é json" });

    await expect(service.listarModelosConsole()).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listarModelosConsole()).rejects.toThrow(/resposta inválida/);
  });

  it("envia Authorization Bearer quando token existe", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "token-secreto",
    });
    respostas.push({ status: 200, body: JSON.stringify({ models: [] }) });

    await service.listarModelosConsole();

    expect(capturas).toHaveLength(1);
    const primeira = capturas[0];
    if (!primeira) throw new Error("captura ausente");
    expect(primeira.options.hostname).toBe("console.test");
    expect(primeira.options.path).toBe("/api/models");
    expect(primeira.headers.Authorization).toBe("Bearer token-secreto");
  });

  it("não envia header Authorization quando token está ausente", async () => {
    const { service } = novoService({
      OPENCLAW_CONSOLE_URL: "https://console.test",
      OPENCLAW_CONSOLE_TOKEN: "",
    });
    respostas.push({ status: 200, body: JSON.stringify({ models: [] }) });

    await service.listarModelosConsole();

    expect(capturas).toHaveLength(1);
    const segunda = capturas[0];
    if (!segunda) throw new Error("captura ausente");
    expect(segunda.headers.Authorization).toBeUndefined();
  });
});
