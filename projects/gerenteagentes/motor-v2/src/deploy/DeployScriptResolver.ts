import { isAbsolute, join } from "node:path"

/** Raiz usada pelo deploy legado quando DEPLOY_REPO_HOST não está definido. */
export const DEFAULT_DEPLOY_REPO_HOST = "/home/alexandre/codigofonte/biblioteca-global"

export interface DeployProjectConfig {
  projectSlug: string
  deploy_script?: string | null
  deploy_host_root?: string | null
}

export interface DeployScriptResolution {
  relativeScript: string
  hostRepoRoot: string
  hostDeployScript: string
}

export interface DeployScriptResolverInput {
  project: DeployProjectConfig
  gitTopLevel: string
  deployRepoHost?: string | null
  defaultRelativeScript: string
  fileExists: (path: string) => boolean
}

/**
 * Resolve a project's deploy script without performing I/O itself.
 *
 * Invariants:
 * - NULL deploy_script preserves the legacy relative script and validation error.
 * - NULL deploy_host_root falls back to DEPLOY_REPO_HOST and then the legacy host root.
 * - A declared script is relative to gitTopLevel and cannot be absolute or escape it.
 * - A declared script must exist before the batch is dispatched.
 */
export function resolveDeployScript(input: DeployScriptResolverInput): DeployScriptResolution {
  const configuredScript = input.project.deploy_script
  const hostRepoRoot = input.project.deploy_host_root
    ?? input.deployRepoHost
    ?? DEFAULT_DEPLOY_REPO_HOST

  if (configuredScript == null) {
    const hostDeployScript = joinHostPath(hostRepoRoot, input.defaultRelativeScript)
    if (!input.fileExists(join(input.gitTopLevel, input.defaultRelativeScript))) {
      throw new Error("deploy-host.sh não encontrado na raiz Git " + input.gitTopLevel)
    }
    return {
      relativeScript: input.defaultRelativeScript,
      hostRepoRoot,
      hostDeployScript,
    }
  }

  assertSafeRelativeScript(configuredScript, input.project.projectSlug)
  const verifiedPath = join(input.gitTopLevel, ...configuredScript.split(/[\\/]+/))
  if (!input.fileExists(verifiedPath)) {
    throw new Error(
      `Script de deploy "${configuredScript}" do projeto "${input.project.projectSlug}" ` +
      `não encontrado; caminho verificado: ${verifiedPath}`,
    )
  }

  return {
    relativeScript: configuredScript,
    hostRepoRoot,
    hostDeployScript: joinHostPath(hostRepoRoot, configuredScript),
  }
}

/** Um lote por repositório não pode executar scripts efetivos diferentes. */
export function assertUniformDeployBatch(
  plans: readonly DeployScriptResolution[],
): void {
  const first = plans[0]
  if (!first) return
  const mixed = plans.some((plan) => plan.hostDeployScript !== first.hostDeployScript)
  if (mixed) {
    throw new Error(
      `Lote de deploy mistura scripts efetivos distintos: ${plans.map((plan) => plan.hostDeployScript).join(", ")}`,
    )
  }
}

function assertSafeRelativeScript(script: string, projectSlug: string): void {
  const absolute = isAbsolute(script) || script.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(script)
  const escapesGitRoot = script.split(/[\\/]+/).some((segment) => segment === "..")
  if (absolute || escapesGitRoot || script.length === 0) {
    throw new Error(
      `Script de deploy inválido para o projeto "${projectSlug}": deve ser um caminho relativo sem '..': ${script}`,
    )
  }
}

function joinHostPath(hostRoot: string, relativeScript: string): string {
  return hostRoot.replace(/\/+$/, "") + "/" + relativeScript.replace(/^\/+/, "")
}
