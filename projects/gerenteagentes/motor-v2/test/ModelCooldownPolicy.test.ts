import { describe, expect, it, vi } from "vitest"
import {
  classifyCooldown,
  cooldownDurationMs,
  cooldownReason,
  modelKey,
  splitModelKey,
  ModelCooldownExhaustedError,
} from "../src/policies/ModelCooldownPolicy.js"
import { ModelCooldownStore } from "../src/database/ModelCooldownStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

const empty = { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult

function fakeDb(responses: QueryResult[] = []): Db {
  return {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? empty),
    transaction: vi.fn(),
  } as unknown as Db
}

const MINUTE = 60_000

describe("ModelCooldownPolicy — classificação do motivo", () => {
  it("classifica falta de token/chave como autenticação", () => {
    expect(classifyCooldown("missing-provider-auth")).toBe("auth")
    expect(classifyCooldown("no API key found for provider")).toBe("auth")
    expect(classifyCooldown("invalid api key")).toBe("auth")
    expect(classifyCooldown("401 Unauthorized")).toBe("auth")
    expect(classifyCooldown("403 forbidden")).toBe("auth")
  })

  it("classifica cota/limite como quota", () => {
    expect(classifyCooldown("429 Your token-plan 1-week quota has been exhausted")).toBe("quota")
    expect(classifyCooldown("rate limit exceeded")).toBe("quota")
    expect(classifyCooldown("insufficient credits")).toBe("quota")
  })

  it("classifica modelo removido como not_found", () => {
    expect(classifyCooldown("model not found")).toBe("not_found")
    expect(classifyCooldown("404 model_not_found")).toBe("not_found")
  })

  it("cai em session quando não há assinatura conhecida", () => {
    expect(classifyCooldown("[SESSION_FAILED] Session failed (run=abc)")).toBe("session")
  })

  it("não confunde o rótulo do próprio Motor com modelo removido", () => {
    // "Modelo indisponível" é texto do Motor, não assinatura do provedor.
    expect(classifyCooldown("Modelo indisponível: openai/gpt-5.6-luna")).toBe("session")
  })
})

describe("ModelCooldownPolicy — duração", () => {
  it("usa a base da classe na primeira falha", () => {
    expect(cooldownDurationMs("auth", 1)).toBe(60 * MINUTE)
    expect(cooldownDurationMs("session", 1)).toBe(15 * MINUTE)
  })

  it("cresce 50% a cada reincidência", () => {
    expect(cooldownDurationMs("auth", 2)).toBe(90 * MINUTE)
    expect(cooldownDurationMs("auth", 3)).toBe(135 * MINUTE)
  })

  it("respeita o teto de 12h", () => {
    expect(cooldownDurationMs("auth", 50)).toBe(12 * 60 * MINUTE)
  })

  it("nunca fica abaixo da base", () => {
    expect(cooldownDurationMs("auth", 0)).toBe(60 * MINUTE)
  })
})

describe("ModelCooldownPolicy — utilitários", () => {
  it("separa provider/model", () => {
    expect(splitModelKey("openai/gpt-5.6-luna")).toEqual({ provider: "openai", model: "gpt-5.6-luna" })
    expect(modelKey("openai", "gpt-5.6-luna")).toBe("openai/gpt-5.6-luna")
  })

  it("preserva barras internas do nome do modelo", () => {
    expect(splitModelKey("ollama/qwen3.5:35b-a3b")).toEqual({ provider: "ollama", model: "qwen3.5:35b-a3b" })
  })

  it("monta a assinatura do motivo com código e mensagem", () => {
    expect(cooldownReason("429", "quota exhausted")).toBe("429 quota exhausted")
    expect(cooldownReason(undefined, "sem chave")).toBe("sem chave")
  })
})

describe("ModelCooldownStore", () => {
  it("registra a primeira falha com strikes=1 e grava a linha", async () => {
    const db = fakeDb([{ rows: [], affectedRows: 0, insertId: 0 }])
    const applied = await new ModelCooldownStore(db).register({
      model: "openai/gpt-5.6-luna",
      reason: "missing-provider-auth",
      now: new Date("2026-09-13T15:00:00Z"),
    })
    expect(applied.classe).toBe("auth")
    expect(applied.strikes).toBe(1)
    expect(applied.until.toISOString()).toBe("2026-09-13T16:00:00.000Z")
    const [sql, params] = vi.mocked(db.query).mock.calls[1] as [string, unknown[]]
    expect(String(sql)).toContain("INSERT INTO modelo_cooldown")
    expect(params[0]).toBe("openai")
    expect(params[1]).toBe("gpt-5.6-luna")
    expect(params[4]).toBe(1)
  })

  it("escala 50% quando o cooldown anterior ainda está vigente", async () => {
    const db = fakeDb([{
      rows: [{ strikes: 1, bloqueado_ate: "2026-09-13T15:30:00.000Z" }],
      affectedRows: 0, insertId: 0,
    }])
    const applied = await new ModelCooldownStore(db).register({
      model: "openai/gpt-5.6-luna",
      reason: "missing-provider-auth",
      now: new Date("2026-09-13T15:20:00Z"),
    })
    expect(applied.strikes).toBe(2)
    expect(applied.until.toISOString()).toBe("2026-09-13T16:50:00.000Z")
  })

  it("zera a reincidência quando o modelo ficou saudável por mais que a janela-base", async () => {
    const db = fakeDb([{
      rows: [{ strikes: 4, bloqueado_ate: "2026-09-13T01:00:00.000Z" }],
      affectedRows: 0, insertId: 0,
    }])
    const applied = await new ModelCooldownStore(db).register({
      model: "openai/gpt-5.6-luna",
      reason: "missing-provider-auth",
      now: new Date("2026-09-13T15:00:00Z"),
    })
    expect(applied.strikes).toBe(1)
  })

  it("lista somente cooldowns vigentes, indexados por provider/model", async () => {
    const db = fakeDb([{
      rows: [
        { provider: "openai", model: "gpt-5.6-luna", motivo_classe: "auth", strikes: 2, bloqueado_ate: "2026-09-13T16:00:00.000Z" },
        { provider: "ollama", model: "qwen3.5:9b", motivo_classe: "session", strikes: 1, bloqueado_ate: "2026-09-13T15:10:00.000Z" },
      ],
      affectedRows: 0, insertId: 0,
    }])
    const active = await new ModelCooldownStore(db).listActive(new Date("2026-09-13T15:00:00Z"))
    expect([...active.keys()]).toEqual(["openai/gpt-5.6-luna", "ollama/qwen3.5:9b"])
    expect(active.get("openai/gpt-5.6-luna")?.classe).toBe("auth")
    const ordered = await new ModelCooldownStore(fakeDb([{
      rows: [
        { provider: "openai", model: "gpt-5.6-luna", motivo_classe: "auth", strikes: 2, bloqueado_ate: "2026-09-13T16:00:00.000Z" },
        { provider: "ollama", model: "qwen3.5:9b", motivo_classe: "session", strikes: 1, bloqueado_ate: "2026-09-13T15:10:00.000Z" },
      ], affectedRows: 0, insertId: 0,
    }])).listActiveOrdered(new Date("2026-09-13T15:00:00Z"))
    expect(ordered.map((c) => c.model)).toEqual(["ollama/qwen3.5:9b", "openai/gpt-5.6-luna"])
  })

  it("restringe a consulta de cooldown vigente pela data atual", async () => {
    const db = fakeDb()
    await new ModelCooldownStore(db).listActive(new Date("2026-09-13T15:00:00Z"))
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain("bloqueado_ate > ?")
    expect(params[0]).toBeInstanceOf(Date)
  })

  it("libera o modelo manualmente", async () => {
    const db = fakeDb()
    await new ModelCooldownStore(db).clear("openai/gpt-5.6-luna")
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain("DELETE FROM modelo_cooldown")
    expect(params).toEqual(["openai", "gpt-5.6-luna"])
  })
})

describe("ModelCooldownExhaustedError", () => {
  it("descreve a cadeia inteira em cooldown com o primeiro horário de liberação", () => {
    const error = new ModelCooldownExhaustedError("development", "gerenteagentes", new Date("2026-09-13T16:00:00Z"), ["openai/gpt-5.6-luna"])
    expect(error.name).toBe("ModelCooldownExhaustedError")
    expect(error.message).toContain("cadeia development")
    expect(error.message).toContain("projeto gerenteagentes")
    expect(error.message).toContain("2026-09-13T16:00:00.000Z")
    expect(error.message).toContain("openai/gpt-5.6-luna")
  })
})
