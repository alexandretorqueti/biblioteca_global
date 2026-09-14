import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_DEPLOY_REPO_HOST,
  assertUniformDeployBatch,
  resolveDeployScript,
  type DeployScriptResolverInput,
} from "../src/deploy/DeployScriptResolver.js"

const defaultRelativeScript = "projects/gerenteagentes/motor-v2/scripts/deploy-host.sh"

function input(overrides: Partial<DeployScriptResolverInput> = {}): DeployScriptResolverInput {
  return {
    project: { projectSlug: "biblioteca-global", deploy_script: null, deploy_host_root: null },
    gitTopLevel: "/workspace/repo",
    deployRepoHost: "/host/repo",
    defaultRelativeScript,
    fileExists: vi.fn(() => true),
    ...overrides,
  }
}

describe("resolveDeployScript", () => {
  it("preserva o script legado e usa DEPLOY_REPO_HOST quando deploy_script é NULL", () => {
    const result = resolveDeployScript(input())

    expect(result).toEqual({
      relativeScript: defaultRelativeScript,
      hostRepoRoot: "/host/repo",
      hostDeployScript: "/host/repo/" + defaultRelativeScript,
    })
  })

  it("usa o script e a raiz de host declarados pelo projeto", () => {
    const fileExists = vi.fn(() => true)
    const result = resolveDeployScript(input({
      project: {
        projectSlug: "taqui",
        deploy_script: "scripts/deploy.sh",
        deploy_host_root: "/srv/taqui",
      },
      fileExists,
    }))

    expect(result).toEqual({
      relativeScript: "scripts/deploy.sh",
      hostRepoRoot: "/srv/taqui",
      hostDeployScript: "/srv/taqui/scripts/deploy.sh",
    })
    expect(fileExists).toHaveBeenCalledWith("/workspace/repo/scripts/deploy.sh")
  })

  it("usa o fallback de host quando DEPLOY_REPO_HOST não é informado", () => {
    const result = resolveDeployScript(input({ deployRepoHost: null }))
    expect(result.hostRepoRoot).toBe(DEFAULT_DEPLOY_REPO_HOST)
  })

  it("rejeita caminho absoluto e tentativa de escapar do toplevel Git", () => {
    for (const deploy_script of ["/tmp/deploy.sh", "../deploy.sh", "scripts/../deploy.sh", "C:\\deploy.sh"]) {
      expect(() => resolveDeployScript(input({ project: { projectSlug: "taqui", deploy_script } })))
        .toThrow(/inválido.*taqui/)
    }
  })

  it("falha imediatamente com projeto e caminho verificado quando o script não existe", () => {
    const result = input({
      project: { projectSlug: "taqui", deploy_script: "scripts/deploy.sh" },
      fileExists: vi.fn(() => false),
    })

    expect(() => resolveDeployScript(result)).toThrow(
      'Script de deploy "scripts/deploy.sh" do projeto "taqui" não encontrado; caminho verificado: /workspace/repo/scripts/deploy.sh',
    )
  })
})

describe("assertUniformDeployBatch", () => {
  it("rejeita um lote com scripts efetivos distintos", () => {
    expect(() => assertUniformDeployBatch([
      { relativeScript: "scripts/a.sh", hostRepoRoot: "/host/repo", hostDeployScript: "/host/repo/scripts/a.sh" },
      { relativeScript: "scripts/b.sh", hostRepoRoot: "/host/repo", hostDeployScript: "/host/repo/scripts/b.sh" },
    ])).toThrow(/scripts efetivos distintos/)
  })
})
