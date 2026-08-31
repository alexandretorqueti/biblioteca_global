import { describe, expect, it } from "vitest"
import { confirmationTestCommand, formatCommandFailure } from "../src/workers/TaskWorker.js"

describe("diagnóstico de comandos do TaskWorker", () => {
  it("preserva stdout com a asserção mesmo quando stderr contém warning", () => {
    const result = formatCommandFailure({
      status: 1,
      stdout: "FAIL ExternalScreen.test.tsx\nAssertionError: expected 1 to be 2\nTest Files 1 failed",
      stderr: "Warning: update was not wrapped in act(...)\n",
    })

    expect(result).toContain("exit=1")
    expect(result).toContain("[stdout]")
    expect(result).toContain("AssertionError: expected 1 to be 2")
    expect(result).toContain("[stderr]")
    expect(result).toContain("not wrapped in act")
  })

  it("remove ANSI e mantém o final quando precisa truncar", () => {
    const result = formatCommandFailure({
      status: 1,
      stdout: `\u001b[31m${"x".repeat(200)}FALHA_REAL_NO_FINAL\u001b[0m`,
    }, 80)

    expect(result).not.toContain("\u001b[")
    expect(result).toContain("saída truncada")
    expect(result).toContain("FALHA_REAL_NO_FINAL")
  })

  it("confirma somente os arquivos que realmente falharam", () => {
    const command = confirmationTestCommand(
      "npm run test",
      "FAIL packages/ui/src/ExternalScreen.test.tsx\nFAIL apps/api/src/crud.spec.ts",
    )

    expect(command).toBe(
      'npm run test -- "packages/ui/src/ExternalScreen.test.tsx" "apps/api/src/crud.spec.ts"',
    )
  })
})
