/**
 * SecretProfileManager — composição de variáveis de ambiente para worktrees
 *
 * Lê o manifesto `task-environment.json` (version 1) da raiz do projeto e
 * materializa os arquivos `.env` no worktree a partir da raiz segura de
 * segredos (TASK_SECRETS_ROOT). NUNCA loga valores de segredos.
 *
 * Referência de comportamento: GerenteAgentes/docs/SEGREDOS-E-WORKSPACES.md
 */

import { chmod, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { createLogger } from "../shared/logger.js"

const logger = createLogger("SecretProfileManager")

export const TASK_ENVIRONMENT_MANIFEST = "task-environment.json"

// ─── Tipos públicos ─────────────────────────────────────────────────────────

export interface EnvironmentManifestFile {
  source: string
  target: string
  required: boolean
}

export interface EnvironmentManifest {
  version: 1
  files: readonly EnvironmentManifestFile[]
}

export type EnvironmentManifestResult =
  | { ok: true; manifest: EnvironmentManifest; manifestPath: string }
  | {
      ok: false
      reason: string
      manifestPath: string
      expected?: string
      actual?: string
      requiredAction: string
    }

export type SecretProfileResult =
  | { ok: true; keys: readonly string[]; env: Readonly<Record<string, string>> }
  | { ok: false; reason: string }

// ─── Validações ─────────────────────────────────────────────────────────────

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,79}$/i

function validateSegment(value: string, name: string): void {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`${name}_invalido`)
}

function validateRelativePath(value: string, name: string): void {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\0") ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${name}_path_invalido`)
  }
}

function validateTargetPath(value: string): void {
  validateRelativePath(value, "target")
  const file = value.split(/[\\/]/).at(-1) ?? ""
  if (file !== ".env" && !file.startsWith(".env.")) {
    throw new Error("target_deve_ser_env")
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseManifest(value: unknown): EnvironmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("raiz_deve_ser_objeto")
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.files)) {
    throw new Error("esperado_version_1_e_files_array")
  }
  const files = record.files.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files_${index}_invalido`)
    }
    const entry = item as Record<string, unknown>
    const allowed = new Set(["source", "target", "required"])
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new Error(`files_${index}_campo_desconhecido`)
    }
    if (
      typeof entry.source !== "string" ||
      !entry.source.trim() ||
      typeof entry.target !== "string" ||
      !entry.target.trim() ||
      typeof entry.required !== "boolean"
    ) {
      throw new Error(`files_${index}_campos_invalidos`)
    }
    return {
      source: entry.source,
      target: entry.target,
      required: entry.required,
    }
  })
  return { version: 1, files }
}

function interpolate(
  value: string,
  environment: string,
  projectSlug: string,
): string {
  return value
    .replaceAll("${environment}", environment)
    .replaceAll("${projectSlug}", projectSlug)
}

function parseEnv(text: string, source: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`${source}:${index + 1}: formato_env_invalido`)
    const key = match[1]!
    let value = match[2] ?? ""
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function quote(value: string): string {
  return JSON.stringify(value)
}

// ─── Classe ─────────────────────────────────────────────────────────────────

export interface InspectManifestInput {
  repoPath: string
  root?: string
  environment: string
  projectSlug: string
}

export interface MaterializeManifestInput {
  repoPath: string
  manifestRepoPath?: string
  root?: string
  environment: string
  projectSlug: string
}

/**
 * Compõe o ambiente de um worktree a partir do manifesto task-environment.json
 * e da raiz segura de segredos (TASK_SECRETS_ROOT).
 *
 * - inspectManifest(): preflight — valida o manifesto e a presença dos arquivos
 *   obrigatórios, sem materializar nada.
 * - materializeManifest(): escreve os arquivos .env no worktree com modo 0600,
 *   mesclando chaves de entradas com o mesmo target (posterior sobrescreve).
 */
export class SecretProfileManager {
  async inspectManifest(
    input: InspectManifestInput,
  ): Promise<EnvironmentManifestResult> {
    const manifestPath = join(input.repoPath, TASK_ENVIRONMENT_MANIFEST)
    try {
      if (!isAbsolute(input.repoPath)) throw new Error("repo_path_invalido")
      validateSegment(input.environment, "environment")
      validateSegment(input.projectSlug, "project")

      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
      const manifest = parseManifest(parsed)

      for (const entry of manifest.files) {
        const source = interpolate(entry.source, input.environment, input.projectSlug)
        validateRelativePath(source, "source")
        validateTargetPath(entry.target)

        if (entry.required) {
          if (!input.root) {
            logger.warn("segredo obrigatório declarado sem TASK_SECRETS_ROOT", {
              source,
              target: entry.target,
            })
            return {
              ok: false,
              reason: `segredo obrigatório '${source}' declarado, mas TASK_SECRETS_ROOT não está configurado`,
              manifestPath,
              expected: source,
              actual: "TASK_SECRETS_ROOT ausente",
              requiredAction:
                "Configurar a raiz de segredos ou tornar a entrada opcional no manifesto",
            }
          }
          try {
            await readFile(join(resolve(input.root), source), "utf8")
          } catch {
            logger.warn("arquivo de segredo obrigatório ausente", {
              source,
              target: entry.target,
            })
            return {
              ok: false,
              reason: `arquivo de ambiente obrigatório ausente: ${source}`,
              manifestPath,
              expected: source,
              actual: "arquivo ausente",
              requiredAction:
                "Criar o arquivo na raiz segura de segredos ou ajustar o manifesto",
            }
          }
        }
      }

      logger.debug("manifesto inspecionado com sucesso", {
        manifestPath,
        files: manifest.files.length,
      })
      return { ok: true, manifest, manifestPath }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "manifesto_invalido"
      logger.warn("manifesto de ambiente inválido", { manifestPath, error: message })
      return {
        ok: false,
        reason: `manifesto de ambiente inválido: ${message}`,
        manifestPath,
        expected: TASK_ENVIRONMENT_MANIFEST,
        actual: message.includes("ENOENT") ? "arquivo ausente" : "conteúdo inválido",
        requiredAction: `Criar ou corrigir ${TASK_ENVIRONMENT_MANIFEST} na raiz do projeto`,
      }
    }
  }

  async materializeManifest(
    input: MaterializeManifestInput,
  ): Promise<SecretProfileResult> {
    const inspected = await this.inspectManifest({
      repoPath: input.manifestRepoPath ?? input.repoPath,
      ...(input.root ? { root: input.root } : {}),
      environment: input.environment,
      projectSlug: input.projectSlug,
    })
    if (!inspected.ok) return { ok: false, reason: inspected.reason }
    if (!input.root) return { ok: true, keys: [], env: {} }

    try {
      const root = resolve(input.root)
      const targets = new Map<string, Map<string, string>>()

      for (const entry of inspected.manifest.files) {
        const source = interpolate(entry.source, input.environment, input.projectSlug)
        let text: string
        try {
          text = await readFile(join(root, source), "utf8")
        } catch (error: unknown) {
          if (
            !entry.required &&
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            continue
          }
          throw error
        }
        const merged = targets.get(entry.target) ?? new Map<string, string>()
        for (const [key, value] of parseEnv(text, source)) merged.set(key, value)
        targets.set(entry.target, merged)
      }

      const all = new Map<string, string>()
      for (const [target, values] of targets) {
        const targetPath = resolve(input.repoPath, target)
        if (relative(resolve(input.repoPath), targetPath).startsWith("..")) {
          throw new Error("target_fora_do_clone")
        }
        const content =
          [...values.entries()]
            .map(([key, value]) => `${key}=${quote(value)}`)
            .join("\n") + "\n"
        await writeFile(targetPath, content, { encoding: "utf8", mode: 0o600 })
        await chmod(targetPath, 0o600)
        logger.debug("arquivo de ambiente materializado", { target, keys: values.size })
        for (const item of values) all.set(item[0], item[1])
      }

      return { ok: true, keys: [...all.keys()], env: Object.fromEntries(all) }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "falha_ao_compor_segredos"
      logger.error("falha ao materializar segredos", { reason })
      return { ok: false, reason }
    }
  }
}
