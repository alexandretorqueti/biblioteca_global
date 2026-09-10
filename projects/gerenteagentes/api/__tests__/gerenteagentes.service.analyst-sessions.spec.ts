// @vitest-environment node
/**
 * Testes do método sessoesAnalistaTarefa() do GerenteAgentesService.
 *
 * Critérios cobertos:
 * - Persistência e consulta de uma sessão de analista por tarefa
 * - Histórico disponível após exclusão da sessão operacional (dados persistidos em banco)
 * - Duas ou mais sessões por escalonamento com ordem de exibição
 * - Exibição do modelo no início de cada sessão
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

// Mocks dos módulos externos
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

/**
 * Cria um service com factory mock que retorna um db mock.
 */
function criarServiceComDb(dbMock: Record<string, unknown>) {
  const factory = {
    obter: vi.fn().mockResolvedValue(dbMock),
  };
  const registry = {};
  const provisionService = {};
  const configService = {
    get: (chave: string) => {
      const env: Record<string, string> = {
        MOTOR_DEV_URL: "http://localhost:3010",
        MOTOR_VERSION: "v2",
        MOTOR_API_PORT: "3010",
      };
      return env[chave];
    },
  } as unknown as ConfigService;

  const service = new GerenteAgentesService(
    factory as never,
    registry as never,
    provisionService as never,
    configService,
  );

  return { service, factory };
}

/**
 * Cria um chain mock do drizzle para select com limit.
 */
function criarDrizzleChainComLimit(result: unknown) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue(result);
  return chain;
}

/**
 * Cria um chain mock do drizzle para select sem limit (orderBy retorna direto).
 */
function criarDrizzleChainSemLimit(result: unknown) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockResolvedValue(result);
  return chain;
}

describe("GerenteAgentesService.sessoesAnalistaTarefa", () => {
  describe("persistência e consulta de uma sessão de analista por tarefa", () => {
    it("retorna available:false quando não há sessões para a tarefa", async () => {
      // Mock do drizzle chain para tarefa (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 1 }]);
      
      // Mock do drizzle chain para sessões vazias (sem limit)
      const sessoesChain = criarDrizzleChainSemLimit([]);

      let callCount = 0;
      const dbMock = {
        select: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return tarefaChain;
          return sessoesChain;
        }),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      const resultado = await service.sessoesAnalistaTarefa(projeto as never, 1);

      expect(resultado).toEqual({ available: false, sessions: [] });
    });

    it("retorna uma sessão com mensagens quando existe", async () => {
      const sessoes = [
        {
          id: 1,
          sessionKey: "analyst-task-1-model-1",
          modelo: "ollama/qwen3-coder:30b",
          executionOrder: 1,
          status: "closed",
          openedAt: new Date("2026-09-10T10:00:00Z"),
          closedAt: new Date("2026-09-10T10:05:00Z"),
          closeReason: "completed",
        },
      ];

      const mensagens = [
        { role: "system", content: "Você é um analista...", sequenceNumber: 0 },
        { role: "user", content: "Analise esta tarefa", sequenceNumber: 1 },
        { role: "assistant", content: "Aqui está a análise...", sequenceNumber: 2 },
      ];

      // Mock do chain do drizzle para tarefa (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 1 }]);
      
      // Mock do chain para sessões (sem limit)
      const sessoesChain = criarDrizzleChainSemLimit(sessoes);
      
      // Mock do chain para mensagens (sem limit)
      const mensagensChain = criarDrizzleChainSemLimit(mensagens);

      let callCount = 0;
      const dbMock = {
        select: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return tarefaChain;
          if (callCount === 2) return sessoesChain;
          return mensagensChain;
        }),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      const resultado = await service.sessoesAnalistaTarefa(projeto as never, 1);

      expect(resultado.available).toBe(true);
      expect(resultado.sessions).toHaveLength(1);
      expect(resultado.sessions[0]).toMatchObject({
        executionOrder: 1,
        model: "ollama/qwen3-coder:30b",
        sessionKey: "analyst-task-1-model-1",
        status: "closed",
      });
      expect(resultado.sessions[0]!.messages).toHaveLength(3);
      expect(resultado.sessions[0]!.text).toContain("[system]");
      expect(resultado.sessions[0]!.text).toContain("[user]");
      expect(resultado.sessions[0]!.text).toContain("[assistant]");
    });
  });

  describe("histórico disponível após exclusão da sessão operacional", () => {
    it("retorna dados persistidos mesmo sem sessão operacional ativa", async () => {
      // Simula o cenário onde a sessão operacional foi apagada,
      // mas os dados persistem no banco (analyst_task_sessions)
      const sessoes = [
        {
          id: 1,
          sessionKey: "analyst-task-1-deleted",
          modelo: "ollama/qwen3-coder:30b",
          executionOrder: 1,
          status: "closed",
          openedAt: new Date("2026-09-10T10:00:00Z"),
          closedAt: new Date("2026-09-10T10:05:00Z"),
          closeReason: "completed",
        },
      ];

      const mensagens = [
        { role: "system", content: "Contexto do analista", sequenceNumber: 0 },
        { role: "assistant", content: "Análise completa da tarefa", sequenceNumber: 1 },
      ];

      // Mock do chain do drizzle para tarefa (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 1 }]);
      
      // Mock do chain para sessões (sem limit)
      const sessoesChain = criarDrizzleChainSemLimit(sessoes);
      
      // Mock do chain para mensagens (sem limit)
      const mensagensChain = criarDrizzleChainSemLimit(mensagens);

      let callCount = 0;
      const dbMock = {
        select: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return tarefaChain;
          if (callCount === 2) return sessoesChain;
          return mensagensChain;
        }),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      const resultado = await service.sessoesAnalistaTarefa(projeto as never, 1);

      // Dados persistidos devem estar disponíveis mesmo sem sessão operacional
      expect(resultado.available).toBe(true);
      expect(resultado.sessions).toHaveLength(1);
      expect(resultado.sessions[0]!.messages).toHaveLength(2);
      expect(resultado.sessions[0]!.text).toContain("Contexto do analista");
      expect(resultado.sessions[0]!.text).toContain("Análise completa da tarefa");
    });
  });

  describe("múltiplas sessões por escalonamento com ordem de exibição", () => {
    it("retorna sessões em ordem de executionOrder quando há escalonamento", async () => {
      // Simula escalonamento: 3 modelos tentados em sequência
      const sessoes = [
        {
          id: 1,
          sessionKey: "analyst-task-1-model-1",
          modelo: "ollama/qwen3-coder:30b",
          executionOrder: 1,
          status: "closed",
          openedAt: new Date("2026-09-10T10:00:00Z"),
          closedAt: new Date("2026-09-10T10:02:00Z"),
          closeReason: "model_unavailable",
        },
        {
          id: 2,
          sessionKey: "analyst-task-1-model-2",
          modelo: "ollama/qwen3.6:35b",
          executionOrder: 2,
          status: "closed",
          openedAt: new Date("2026-09-10T10:02:00Z"),
          closedAt: new Date("2026-09-10T10:04:00Z"),
          closeReason: "model_unavailable",
        },
        {
          id: 3,
          sessionKey: "analyst-task-1-model-3",
          modelo: "alibaba/qwen3.7-plus",
          executionOrder: 3,
          status: "closed",
          openedAt: new Date("2026-09-10T10:04:00Z"),
          closedAt: new Date("2026-09-10T10:10:00Z"),
          closeReason: "completed",
        },
      ];

      const mensagensPorSessao: Record<number, Array<{ role: string; content: string; sequenceNumber: number }>> = {
        1: [
          { role: "system", content: "Tentativa 1", sequenceNumber: 0 },
          { role: "assistant", content: "Erro de autenticação", sequenceNumber: 1 },
        ],
        2: [
          { role: "system", content: "Tentativa 2", sequenceNumber: 0 },
          { role: "assistant", content: "Modelo indisponível", sequenceNumber: 1 },
        ],
        3: [
          { role: "system", content: "Tentativa 3 - sucesso", sequenceNumber: 0 },
          { role: "user", content: "Tarefa de desenvolvimento", sequenceNumber: 1 },
          { role: "assistant", content: "Análise completa com sucesso", sequenceNumber: 2 },
        ],
      };

      // Mock do chain do drizzle para tarefa (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 1 }]);
      
      // Mock do chain para sessões (sem limit)
      const sessoesChain = criarDrizzleChainSemLimit(sessoes);

      let callCount = 0;
      const dbMock = {
        select: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return tarefaChain;
          if (callCount === 2) return sessoesChain;
          // Para mensagens, retorna baseado no sessionId
          const sessionId = callCount - 2; // 1, 2, 3
          return criarDrizzleChainSemLimit(mensagensPorSessao[sessionId] ?? []);
        }),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      const resultado = await service.sessoesAnalistaTarefa(projeto as never, 1);

      expect(resultado.available).toBe(true);
      expect(resultado.sessions).toHaveLength(3);

      // Verifica ordem de execução
      expect(resultado.sessions[0]!.executionOrder).toBe(1);
      expect(resultado.sessions[1]!.executionOrder).toBe(2);
      expect(resultado.sessions[2]!.executionOrder).toBe(3);

      // Verifica modelos em cada sessão
      expect(resultado.sessions[0]!.model).toBe("ollama/qwen3-coder:30b");
      expect(resultado.sessions[1]!.model).toBe("ollama/qwen3.6:35b");
      expect(resultado.sessions[2]!.model).toBe("alibaba/qwen3.7-plus");

      // Verifica que as sessões estão ordenadas corretamente
      const models = resultado.sessions.map((s) => s.model);
      expect(models).toEqual([
        "ollama/qwen3-coder:30b",
        "ollama/qwen3.6:35b",
        "alibaba/qwen3.7-plus",
      ]);
    });
  });

  describe("exibição do modelo no início de cada sessão", () => {
    it("inclui o nome do modelo em cada sessão retornada", async () => {
      const sessoes = [
        {
          id: 1,
          sessionKey: "analyst-task-1",
          modelo: "alibaba/qwen3.7-plus",
          executionOrder: 1,
          status: "closed",
          openedAt: new Date("2026-09-10T10:00:00Z"),
          closedAt: new Date("2026-09-10T10:05:00Z"),
          closeReason: "completed",
        },
      ];

      const mensagens = [
        { role: "system", content: "Prompt do analista", sequenceNumber: 0 },
        { role: "assistant", content: "Resposta", sequenceNumber: 1 },
      ];

      // Mock do chain do drizzle para tarefa (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 1 }]);
      
      // Mock do chain para sessões (sem limit)
      const sessoesChain = criarDrizzleChainSemLimit(sessoes);
      
      // Mock do chain para mensagens (sem limit)
      const mensagensChain = criarDrizzleChainSemLimit(mensagens);

      let callCount = 0;
      const dbMock = {
        select: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return tarefaChain;
          if (callCount === 2) return sessoesChain;
          return mensagensChain;
        }),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      const resultado = await service.sessoesAnalistaTarefa(projeto as never, 1);

      expect(resultado.available).toBe(true);
      expect(resultado.sessions).toHaveLength(1);
      
      // O modelo deve estar presente na sessão
      const sessao = resultado.sessions[0]!;
      expect(sessao.model).toBe("alibaba/qwen3.7-plus");
      expect(typeof sessao.model).toBe("string");
      expect(sessao.model.length).toBeGreaterThan(0);
    });
  });

  describe("validação de projeto", () => {
    it("lança NotFoundException quando a tarefa não existe", async () => {
      // Mock do chain do drizzle para tarefa não encontrada (com limit)
      const tarefaChain = criarDrizzleChainComLimit([]);

      const dbMock = {
        select: vi.fn().mockReturnValue(tarefaChain),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      await expect(
        service.sessoesAnalistaTarefa(projeto as never, 999),
      ).rejects.toThrow(NotFoundException);
    });

    it("lança NotFoundException quando a tarefa pertence a outro projeto", async () => {
      // Mock do chain do drizzle para tarefa de outro projeto (com limit)
      const tarefaChain = criarDrizzleChainComLimit([{ projetoId: 999 }]);

      const dbMock = {
        select: vi.fn().mockReturnValue(tarefaChain),
      };

      const { service } = criarServiceComDb(dbMock);
      const projeto = { id: 1, nome: "Projeto Teste", slug: "teste" };

      await expect(
        service.sessoesAnalistaTarefa(projeto as never, 1),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
