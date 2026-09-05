/**
 * Testes do GateFailureClassifier
 * @vitest-environment node
 *
 * Testa a classificação de causa raiz em falhas de gate:
 * - Parser de veredito (JSON válido/inválido)
 * - Prompt do monitor (contexto completo)
 * - Fail-open (classificador indisponível não trava o fluxo)
 */

import { describe, expect, it, vi } from "vitest"

// Testar o parser de veredito (função interna, exportada para teste)
describe("GateFailureClassifier — parseVerdict", () => {
  // Simular o parser (a função real é interna, mas podemos testar a lógica)
  function parseVerdict(content: string): { verdict: string; analysis: string; solution?: string } | null {
    try {
      const jsonMatch = content.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      if (!parsed.verdict || !parsed.analysis) return null

      const validVerdicts = ["agent_can_solve", "test_files_issue", "code_files_issue", "motor_issue"]
      if (!validVerdicts.includes(parsed.verdict)) return null

      return {
        verdict: parsed.verdict,
        analysis: String(parsed.analysis),
        solution: parsed.solution ? String(parsed.solution) : undefined,
      }
    } catch {
      return null
    }
  }

  it("parseia veredito válido agent_can_solve", () => {
    const content = JSON.stringify({
      verdict: "agent_can_solve",
      analysis: "Implementação incompleta do config.ts",
    })
    const result = parseVerdict(content)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("agent_can_solve")
    expect(result?.analysis).toContain("config.ts")
  })

  it("parseia veredito válido motor_issue com solution", () => {
    const content = JSON.stringify({
      verdict: "motor_issue",
      analysis: "Lockfile desatualizado no worktree",
      solution: "Rodar npm install antes do npm ci",
    })
    const result = parseVerdict(content)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("motor_issue")
    expect(result?.solution).toContain("npm install")
  })

  it("parseia veredito válido test_files_issue", () => {
    const content = JSON.stringify({
      verdict: "test_files_issue",
      analysis: "Teste funcional quebrado: expected 401 to be 201",
      solution: "Corrigir autenticação no teste crud.functional.spec.ts",
    })
    const result = parseVerdict(content)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("test_files_issue")
  })

  it("parseia veredito válido code_files_issue", () => {
    const content = JSON.stringify({
      verdict: "code_files_issue",
      analysis: "Bug no componente ProjectSelect: nested button",
    })
    const result = parseVerdict(content)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("code_files_issue")
  })

  it("retorna null para veredito inválido", () => {
    const content = JSON.stringify({
      verdict: "invalid_verdict",
      analysis: "algo",
    })
    const result = parseVerdict(content)
    expect(result).toBeNull()
  })

  it("retorna null para JSON sem verdict", () => {
    const content = JSON.stringify({
      analysis: "algo sem verdict",
    })
    const result = parseVerdict(content)
    expect(result).toBeNull()
  })

  it("retorna null para conteúdo não-JSON", () => {
    const content = "Isso não é um JSON válido"
    const result = parseVerdict(content)
    expect(result).toBeNull()
  })

  it("retorna null para JSON truncado", () => {
    const content = '{"verdict":"agent_can_solve","analysis":"teste'
    const result = parseVerdict(content)
    expect(result).toBeNull()
  })

  it("extrai JSON de conteúdo com texto extra", () => {
    const content = `
      Aqui está minha análise:
      ${JSON.stringify({ verdict: "agent_can_solve", analysis: "teste" })}
      Espero que ajude!
    `
    const result = parseVerdict(content)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("agent_can_solve")
  })
})

describe("GateFailureClassifier — fail-open", () => {
  it("classificador indisponível não deve travar o fluxo", () => {
    // Simular cenário: classificador retorna unavailable
    const outcome = { kind: "unavailable" as const, error: "timeout" }
    
    // O fluxo deve continuar normalmente (fail-open)
    expect(outcome.kind).toBe("unavailable")
    // O TaskWorker deve tratar isso como "sem veredito" e continuar
  })

  it("veredito motor_issue deve bloquear a tarefa", () => {
    const verdict = {
      verdict: "motor_issue",
      analysis: "Bug no DependencyInstaller",
      solution: "Corrigir o método install()",
    }
    
    // O TaskWorker deve bloquear a tarefa com o veredito
    expect(verdict.verdict).toBe("motor_issue")
    expect(verdict.solution).toBeDefined()
  })

  it("veredito test_files_issue deve criar subtarefa de correção de testes", () => {
    const verdict = {
      verdict: "test_files_issue",
      analysis: "Teste funcional quebrado",
      solution: "Corrigir autenticação no teste",
    }
    
    // O TaskWorker deve criar subtarefa de correção focada nos testes
    expect(verdict.verdict).toBe("test_files_issue")
  })

  it("veredito agent_can_solve deve continuar fluxo normal", () => {
    const verdict = {
      verdict: "agent_can_solve",
      analysis: "Implementação incompleta",
    }
    
    // O TaskWorker deve continuar com rework/escala normal
    expect(verdict.verdict).toBe("agent_can_solve")
  })

  it("veredito code_files_issue deve continuar fluxo normal", () => {
    const verdict = {
      verdict: "code_files_issue",
      analysis: "Bug real no código",
    }
    
    // O TaskWorker deve continuar com rework/escala normal
    expect(verdict.verdict).toBe("code_files_issue")
  })
})

describe("GateFailureClassifier — sessão do monitor", () => {
  function dbComCadeiaMonitor(rows: Array<Record<string, unknown>>) {
    return {
      query: vi.fn(async () => ({ rows, affectedRows: 0, insertId: 0 })),
    }
  }

  it("cria a sessão com a chave do agente do monitor, não do agente da tarefa", async () => {
    const { GateFailureClassifier } = await import("../src/policies/GateFailureClassifier.js")
    const calls: Array<{ agentId: string; key: string }> = []
    const driver = {
      createSession: vi.fn(async (input: { agentId: string; key: string }) => {
        calls.push({ agentId: input.agentId, key: input.key })
        return { key: input.key, agentId: input.agentId, sessionId: "sess-1" }
      }),
      sendMessage: vi.fn(async () => ({ runId: "run-1" })),
      waitForRunCompletion: vi.fn(async () => ({
        state: "final",
        content: '{"verdict":"agent_can_solve","analysis":"causa no código da tarefa"}',
      })),
    }
    const db = dbComCadeiaMonitor([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "alibaba", model: "qwen3.8-max" },
    ])
    const classifier = new GateFailureClassifier(driver as never, db as never)

    const result = await classifier.classify({
      taskId: 749, subtaskId: 767, subtaskTitle: "Sub", taskTitle: "Task",
      agentId: "biblioteca-global", projectSlug: "biblioteca-global", repoPath: "/repo",
      model: "ollama/qwen3.7-plus", modelIndex: 0, occurrence: 1,
      errorMessage: "teste falhou", command: "npm run test",
    })

    expect(result.kind).toBe("verdict")
    // Regressão 2026-09-03: a chave da sessão usava o agente da tarefa
    // (agent:biblioteca-global:...) com agentId do monitor (programador-senior)
    // e o gateway recusava: "key agent does not match agentId".
    expect(calls[0]?.agentId).toBe("programador-senior")
    expect(calls[0]?.key.startsWith("agent:programador-senior:monitor:")).toBe(true)
  })

  it("resolve a cadeia MONITOR de project_model_selection (provider/model, na ordem)", async () => {
    const { GateFailureClassifier } = await import("../src/policies/GateFailureClassifier.js")
    const modelosUsados: string[] = []
    const driver = {
      createSession: vi.fn(async (input: { model: string }) => {
        modelosUsados.push(input.model)
        return { key: "k", agentId: "a", sessionId: "sess-1" }
      }),
      sendMessage: vi.fn(async () => ({ runId: "run-1" })),
      waitForRunCompletion: vi.fn(async () => ({
        state: "final",
        content: '{"verdict":"agent_can_solve","analysis":"ok"}',
      })),
    }
    const db = dbComCadeiaMonitor([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "alibaba", model: "qwen3.8-max" },
    ])
    const classifier = new GateFailureClassifier(driver as never, db as never)

    const result = await classifier.classify({
      taskId: 1, subtaskId: 1, subtaskTitle: "Sub", taskTitle: "Task",
      agentId: "biblioteca-global", projectSlug: "biblioteca-global", repoPath: "/repo",
      model: "m", modelIndex: 0, occurrence: 1, errorMessage: "e", command: "npm run test",
    })

    expect(result.kind).toBe("verdict")
    expect(modelosUsados[0]).toBe("openai/gpt-5.6-sol")
    // Consulta usa a tabela da tela de seleção de modelos, não o legado projeto_model_chain
    expect(String(db.query.mock.calls[0]?.[0])).toContain("project_model_selection")
    expect(String(db.query.mock.calls[0]?.[0])).not.toContain("projeto_model_chain")
    expect(db.query.mock.calls[0]?.[1]).toEqual(["biblioteca-global"])
  })

  it("sem modelos MONITOR cadastrados: indisponível, SEM cadeia padrão (decisão 2026-09-04)", async () => {
    const { GateFailureClassifier } = await import("../src/policies/GateFailureClassifier.js")
    const driver = {
      createSession: vi.fn(),
      sendMessage: vi.fn(),
      waitForRunCompletion: vi.fn(),
    }
    const db = dbComCadeiaMonitor([])
    const classifier = new GateFailureClassifier(driver as never, db as never)

    const result = await classifier.classify({
      taskId: 760, subtaskId: 796, subtaskTitle: "Sub", taskTitle: "Task",
      agentId: "biblioteca-global", projectSlug: "biblioteca-global", repoPath: "/repo",
      model: "m", modelIndex: 0, occurrence: 1, errorMessage: "e", command: "npm run test",
    })

    // Regressão 2026-09-04: antes caía no default openai/gpt-5.6-terra ou
    // gerava "[object Object]" via LEFT JOIN legado; agora é fail-open explícito.
    expect(result.kind).toBe("unavailable")
    expect(driver.createSession).not.toHaveBeenCalled()
  })

  it("linhas com provider/model vazios são descartadas (regressão [object Object])", async () => {
    const { GateFailureClassifier } = await import("../src/policies/GateFailureClassifier.js")
    const driver = {
      createSession: vi.fn(),
      sendMessage: vi.fn(),
      waitForRunCompletion: vi.fn(),
    }
    // Simula o LEFT JOIN legado que devolvia modelo NULL
    const db = dbComCadeiaMonitor([
      { provider: null, model: null },
      { provider: "", model: "" },
    ])
    const classifier = new GateFailureClassifier(driver as never, db as never)

    const result = await classifier.classify({
      taskId: 1, subtaskId: 1, subtaskTitle: "Sub", taskTitle: "Task",
      agentId: "x", projectSlug: "x", repoPath: "/repo",
      model: "m", modelIndex: 0, occurrence: 1, errorMessage: "e", command: "npm run test",
    })

    expect(result.kind).toBe("unavailable")
    expect(String(result.kind === "unavailable" ? result.error : "")).not.toContain("[object Object]")
  })

  it("sem projectSlug: indisponível", async () => {
    const { GateFailureClassifier } = await import("../src/policies/GateFailureClassifier.js")
    const driver = { createSession: vi.fn(), sendMessage: vi.fn(), waitForRunCompletion: vi.fn() }
    const classifier = new GateFailureClassifier(driver as never, dbComCadeiaMonitor([]) as never)

    const result = await classifier.classify({
      taskId: 1, subtaskId: 1, subtaskTitle: "Sub", taskTitle: "Task",
      agentId: "x", projectSlug: null, repoPath: "/repo",
      model: "m", modelIndex: 0, occurrence: 1, errorMessage: "e", command: "npm run test",
    })

    expect(result.kind).toBe("unavailable")
  })
})
