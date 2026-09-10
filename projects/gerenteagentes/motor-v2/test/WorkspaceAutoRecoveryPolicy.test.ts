import { describe, expect, it } from "vitest"
import { identifyWorkspaceAutoRecovery } from "../src/policies/WorkspaceAutoRecoveryPolicy.js"

describe("WorkspaceAutoRecoveryPolicy", () => {
  it("identifica not a git repository antes de existir commit", () => {
    const decision = identifyWorkspaceAutoRecovery({
      error: "[error] exit=128 fatal: not a git repository: (null)",
      phase: "execute",
      subtaskId: 935,
      workspaceCommitSha: null,
    })
    expect(decision.recoverable).toBe(true)
    expect(decision.code).toBe("git_workspace_invalid")
    expect(decision.fingerprint).toHaveLength(24)
  })

  it.each([
    "CONFLICT (content): Merge conflict in arquivo.ts",
    "preflight Git: blocked; projeto da tarefa: arquivo.ts",
    "Tests failed: expected 1 to be 2",
    "Projeto sem agente configurado",
  ])("não recupera falhas que exigem decisão ou correção real: %s", (error) => {
    expect(identifyWorkspaceAutoRecovery({ error, phase: "execute", subtaskId: 935, workspaceCommitSha: null }).recoverable).toBe(false)
  })

  it("não recupera análise nem subtarefa que já produziu commit", () => {
    expect(identifyWorkspaceAutoRecovery({ error: "fatal: not a git repository", phase: "analyze" }).recoverable).toBe(false)
    expect(identifyWorkspaceAutoRecovery({
      error: "fatal: not a git repository", phase: "execute", subtaskId: 935, workspaceCommitSha: "a".repeat(40),
    }).recoverable).toBe(false)
  })
})
