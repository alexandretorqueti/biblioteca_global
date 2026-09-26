// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
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

interface Captura {
  options: Record<string, unknown>;
}

let capturas: Captura[] = [];

function montarRequestMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const request = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    capturas.push({ options: _options });

    const res = {
      setEncoding: vi.fn(),
      statusCode: 200,
      on: vi.fn((evento: string, handler: (chunk?: string) => void) => {
        if (evento === "data") setImmediate(() => handler("{}"));
        else if (evento === "end") setImmediate(() => handler());
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
  const execute = vi.fn().mockResolvedValue([[], []]);
  const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<void>) => {
    await callback({ execute });
  });
  const db = { execute, transaction };
  const obter = vi.fn().mockResolvedValue(db);
  return {
    service: new GerenteAgentesService({ obter } as never, {} as never, {} as never, configService),
  };
}

beforeEach(() => {
  vi.mocked(httpsRequest).mockReset();
  vi.mocked(httpRequest).mockReset();
  capturas = [];
  vi.mocked(httpsRequest).mockImplementation(montarRequestMock() as never);
  vi.mocked(httpRequest).mockImplementation(montarRequestMock() as never);
});

describe("GerenteAgentesService — timeout para tarefas bloqueadas", () => {
  it("timeout padrão é 180_000ms", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await service.atividadeMotor({} as never);

    expect(capturas).toHaveLength(1);
    expect(capturas[0]?.options.timeout).toBe(180_000);
  });

  it("timeout configurável via MOTOR_REQUEST_TIMEOUT_MS sobrescreve o padrão", async () => {
    const { service } = novoService({
      MOTOR_DEV_URL: "http://motor.test:6282",
      MOTOR_REQUEST_TIMEOUT_MS: "300000",
    });

    await service.atividadeMotor({} as never);

    expect(capturas[0]?.options.timeout).toBe(300_000);
  });

  it("timeout é aplicado a requisições PUT", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await (service as unknown as {
      motorRequest: (method: string, path: string) => Promise<unknown>;
    }).motorRequest("PUT", "/test");

    expect(capturas[0]?.options.timeout).toBe(180_000);
    expect(capturas[0]?.options.method).toBe("PUT");
  });

  it("não usa mais o timeout anterior de 90_000ms", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await service.atividadeMotor({} as never);

    expect(capturas[0]?.options.timeout).not.toBe(90_000);
    expect(capturas[0]?.options.timeout).toBeGreaterThanOrEqual(135_000);
  });
});
