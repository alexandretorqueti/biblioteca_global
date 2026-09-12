// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";

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

import { GerenteAgentesService } from "../gerenteagentes.service";

function chain(result: unknown) {
  const value = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  value.from.mockReturnValue(value);
  value.where.mockReturnValue(value);
  value.orderBy.mockReturnValue(value);
  value.limit.mockResolvedValue(result);
  return value;
}

function serviceWithDb(db: { select: ReturnType<typeof vi.fn> }) {
  return new GerenteAgentesService(
    { obter: vi.fn().mockResolvedValue(db) } as never,
    {} as never,
    {} as never,
    { get: vi.fn() } as unknown as ConfigService,
  );
}

describe("GerenteAgentesService.sessaoSubtarefa", () => {
  it("preserva a tentativa e aninha uma página independente de mensagens", async () => {
    const tarefa = chain([{ projetoId: 1 }]);
    const subtarefa = chain([{ id: 7 }]);
    const sessoes = {
      from: vi.fn(), where: vi.fn(), orderBy: vi.fn(),
    };
    sessoes.from.mockReturnValue(sessoes);
    sessoes.where.mockReturnValue(sessoes);
    sessoes.orderBy.mockResolvedValue([{
      id: 10,
      model: "provider/model-a",
      sessionKey: "task-1-subtask-1-model-1",
      status: "closed",
      openedAt: new Date("2026-09-10T10:00:00Z"),
      closedAt: new Date("2026-09-10T10:05:00Z"),
      closeReason: "completed",
    }]);
    const mensagens = chain([
      { id: 2, role: "assistant", content: "fim", sequenceNumber: 2, occurredAt: null },
      { id: 1, role: "user", content: "início", sequenceNumber: 1, occurredAt: null },
    ]);
    let calls = 0;
    const db = { select: vi.fn(() => [tarefa, subtarefa, sessoes, mensagens][calls++]) };
    const result = await serviceWithDb(db).sessaoSubtarefa(
      { id: 1 } as never,
      1,
      1,
      { pageSize: 2 },
    );

    expect(result.available).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      model: "provider/model-a",
      sessionKey: "task-1-subtask-1-model-1",
      status: "closed",
      messages: {
        items: [
          { sequenceNumber: 2, role: "assistant", text: "fim" },
          { sequenceNumber: 1, role: "user", text: "início" },
        ],
        nextCursor: null,
        hasNextPage: false,
      },
    });
  });

  it("retorna lista de tentativas vazia quando não há histórico", async () => {
    const tarefa = chain([{ projetoId: 1 }]);
    const subtarefa = chain([{ id: 7 }]);
    const sessoes = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn() };
    sessoes.from.mockReturnValue(sessoes);
    sessoes.where.mockReturnValue(sessoes);
    sessoes.orderBy.mockResolvedValue([]);
    let calls = 0;
    const db = { select: vi.fn(() => [tarefa, subtarefa, sessoes][calls++]) };

    await expect(serviceWithDb(db).sessaoSubtarefa({ id: 1 } as never, 1, 1))
      .resolves.toEqual({ available: false, sessions: [] });
  });
});
