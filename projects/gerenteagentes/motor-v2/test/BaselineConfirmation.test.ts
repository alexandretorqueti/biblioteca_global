/**
 * P1 (2026-09-05): confirmação de falha independente das alterações via
 * git stash. Falha SEM o código do agente → baseline_red/ambiente (não é
 * culpa do agente). Passa sem o código → rejeição normal.
 */
import { describe, expect, it } from "vitest"
import { classifyBaselineRedKind, confirmBaselineIndependentFailure } from "../src/policies/BaselineConfirmation.js"

interface RecordedCall {
  command: string
  cwd: string
}

function createRunner(options: {
  status?: string
  failCommands?: string[]
  failOnStashPop?: boolean
}) {
  const calls: RecordedCall[] = []
  const failCommands = options.failCommands ?? []
  const runner = (command: string, cwd: string): string => {
    calls.push({ command, cwd })
    if (command === "git status --porcelain") return options.status ?? ""
    if (command === "git stash pop" && options.failOnStashPop) throw new Error("CONFLICT (content): stash pop falhou")
    if (failCommands.some((fail) => command.includes(fail))) {
      throw new Error("exit=1\n[stdout]\nAssertionError: expected 3 to be 4\n FAIL src/x.test.ts")
    }
    return ""
  }
  return { runner, calls }
}

describe("confirmBaselineIndependentFailure", () => {
  it("workspace sem alterações: falha reproduzida é baseline red (sem stash)", () => {
    const { runner, calls } = createRunner({ status: "", failCommands: ["npm run test"] })
    const result = confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test -- x.test.ts", runner })
    expect(result.baselineRed).toBe(true)
    expect(result.kind).toBe("baseline_red")
    expect(result.stashApplied).toBe(false)
    expect(calls.some((call) => call.command.startsWith("git stash push"))).toBe(false)
  })

  it("workspace sem alterações: teste passa → flake, não é baseline red", () => {
    const { runner } = createRunner({ status: "", failCommands: [] })
    const result = confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test", runner })
    expect(result.baselineRed).toBe(false)
    expect(result.evidence).toContain("flake")
  })

  it("com alterações: stash → falha persiste SEM o código do agente → baseline red, e pop restaura", () => {
    const { runner, calls } = createRunner({ status: " M src/x.ts", failCommands: ["npm run test"] })
    const result = confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test", runner })
    expect(result.baselineRed).toBe(true)
    expect(result.stashApplied).toBe(true)
    expect(result.evidence).toContain("git stash")
    const commands = calls.map((call) => call.command)
    expect(commands).toEqual([
      "git status --porcelain",
      expect.stringContaining("git stash push -u -m motor-baseline-confirmation"),
      "npm run test",
      "git stash pop",
    ])
  })

  it("com alterações: stash → teste passa → a falha depende do código do agente (rejeição normal)", () => {
    const { runner, calls } = createRunner({ status: " M src/x.ts", failCommands: [] })
    const result = confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test", runner })
    expect(result.baselineRed).toBe(false)
    expect(result.stashApplied).toBe(true)
    expect(calls.map((call) => call.command)).toContain("git stash pop")
  })

  it("falha com assinatura de infraestrutura classifica como environment", () => {
    const { runner } = createRunner({ status: "", failCommands: [] })
    const failing = (command: string, cwd: string): string => {
      if (command === "git status --porcelain") return ""
      if (command.startsWith("npm run test")) throw new Error("exit=1\nError: connect ECONNREFUSED 127.0.0.1:3306")
      return runner(command, cwd)
    }
    const result = confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test", runner: failing })
    expect(result.baselineRed).toBe(true)
    expect(result.kind).toBe("environment")
  })

  it("pop falhando lança bloqueio ambiental (nunca atribui ao agente)", () => {
    const { runner } = createRunner({ status: " M src/x.ts", failCommands: ["npm run test"], failOnStashPop: true })
    expect(() =>
      confirmBaselineIndependentFailure({ repoPath: "/repo", confirmationCommand: "npm run test", runner }),
    ).toThrow(/Ambiente bloqueado.*git stash pop/s)
  })
})

describe("classifyBaselineRedKind", () => {
  it("assinaturas de conexão/binário ausente são environment", () => {
    expect(classifyBaselineRedKind("Error: connect ECONNREFUSED 10.0.0.1:3306")).toBe("environment")
    expect(classifyBaselineRedKind("bash: line 1: docker: command not found")).toBe("environment")
    expect(classifyBaselineRedKind("spawn vitest ENOENT")).toBe("environment")
  })

  it("falha de asserção é baseline_red", () => {
    expect(classifyBaselineRedKind("AssertionError: expected 3 to be 4")).toBe("baseline_red")
  })
})
