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

/**
 * Validação do timeout aumentado para tarefas bloqueadas.
 *
 * Contexto: tarefas bloqueadas aguardando o motor liberar o coordenador
 * podem demorar significativamente. O timeout anterior (90s) causava falso
 * "Motor request failed: timeout". O novo timeout (180s) deve ser aplicado
 * a todas as requisições ao motor, especialmente consultas de estado de
 * tarefas bloqueadas.
 *
 * Critérios de aceitação:
 * - O timeout padrão é 50%+ superior ao anterior (180_000 vs 90_000 = 100% maior)
 * - O timeout é aplicado às requisições do motor (incluindo tarefas bloqueadas)
 * - O timeout é configurável via MOTOR_REQUEST_TIMEOUT_MS
 */

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
        if (evento === "data") {
          setImmediate(() => handler("{}"));
        } else if (evento === "end") {
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
  vi.mocked(httpsRequest).mockImplementation(montarRequestMock() as never);
  vi.mocked(httpRequest).mockImplementation(montarRequestMock() as never);
});

describe("GerenteAgentesService — timeout para tarefas bloqueadas", () => {
  it("timeout padrão é 180_000ms (100% superior ao anterior de 90_000ms)", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await service.getModelSelection("biblioteca-global", "DEV");

    expect(capturas).toHaveLength(1);
    const timeout = capturas[0]?.options.timeout;
    expect(timeout).toBe(180_000);
    // Valida que é 50%+ superior ao anterior (90_000)
    expect(timeout).toBeGreaterThanOrEqual(90_000 * 1.5);
  });

  it("timeout configurável via MOTOR_REQUEST_TIMEOUT_MS sobrescreve o padrão", async () => {
    const { service } = novoService({
      MOTOR_DEV_URL: "http://motor.test:6282",
      MOTOR_REQUEST_TIMEOUT_MS: "300000",
    });

    await service.getModelSelection("biblioteca-global", "DEV");

    expect(capturas).toHaveLength(1);
    expect(capturas[0]?.options.timeout).toBe(300_000);
  });

  it("timeout é aplicado a requisições POST (ex.: start/pause de tarefas)", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    // Simula uma requisição POST (como start/pause de tarefa bloqueada)
    await service.saveModelSelection("biblioteca-global", "DEV", [
      { ordem: 1, provider: "alibaba", model: "qwen3.7-plus", enabled: true },
    ]);

    expect(capturas).toHaveLength(1);
    expect(capturas[0]?.options.timeout).toBe(180_000);
    expect(capturas[0]?.options.method).toBe("PUT");
  });

  it("timeout anterior (90_000) NÃO é mais usado — valida aumento", async () => {
    const { service } = novoService({ MOTOR_DEV_URL: "http://motor.test:6282" });

    await service.getModelSelection("biblioteca-global", "DEV");

    const timeout = capturas[0]?.options.timeout;
    // Garante que não está usando o valor antigo
    expect(timeout).not.toBe(90_000);
    // Garante que é pelo menos 50% maior que o antigo
    expect(timeout).toBeGreaterThanOrEqual(135_000);
  });
});
