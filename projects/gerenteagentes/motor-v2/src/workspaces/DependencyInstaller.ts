/**
 * DependencyInstaller — instala dependências (npm ci) no worktree com salvaguardas
 *
 * Responsabilidades:
 * - Detecta package-lock.json na raiz do worktree
 * - Captura git status --porcelain antes/depois do npm ci
 * - Falha se o npm ci alterar qualquer arquivo rastreado
 * - Timeout configurável via TASK_DEPENDENCY_INSTALL_TIMEOUT_MS (default 15min)
 * - Sem package-lock.json → pula silenciosamente
 *
 * O runner de comandos é injetável para testes unitários.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createLogger } from "../shared/logger.js"

const logger = createLogger("DependencyInstaller")

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface CommandRunner {
  /**
   * Executa um comando shell no cwd informado com timeout em ms.
   * Retorna { stdout, stderr, exitCode }.
   * Para compatibilidade com o legado (execSync), lançar erro em exit code != 0.
   */
  run(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }>
}

export interface DependencyInstallResult {
  ok: true
  skipped: boolean
  reason?: string
}

export interface DependencyInstallError {
  ok: false
  reason: string
}

export type DependencyInstallOutcome = DependencyInstallResult | DependencyInstallError

// ─── Runner padrão (execSync) ───────────────────────────────────────────────

const ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

function cleanOutput(value: string | Buffer | undefined | null): string {
  return (typeof value === "string" ? value : value?.toString() ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\r/g, "")
    .trim()
}

class NodeCommandRunner implements CommandRunner {
  async run(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    try {
      const stdout = execSync(command, {
        cwd,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      return { stdout: stdout ?? "", stderr: "" }
    } catch (error: unknown) {
      // Formata a saída do erro para diagnóstico (sem depender de TaskWorker)
      const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number | null; signal?: NodeJS.Signals | null; message?: string }
      const stdout = cleanOutput(err.stdout)
      const stderr = cleanOutput(err.stderr)
      const metadata = [
        err.status != null ? `exit=${err.status}` : "",
        err.signal ? `signal=${err.signal}` : "",
      ].filter(Boolean).join(" ")
      const sections = [
        metadata,
        stdout ? `[stdout]\n${stdout}` : "",
        stderr ? `[stderr]\n${stderr}` : "",
        !stdout && !stderr ? cleanOutput(err.message) : "",
      ].filter(Boolean)
      const combined = sections.join("\n\n") || "Comando encerrou sem saída diagnóstica"
      throw new Error(combined, { cause: error })
    }
  }
}

// ─── Constantes ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutos (igual ao legado)

// ─── Classe ─────────────────────────────────────────────────────────────────

export interface InstallDependenciesInput {
  worktreePath: string
  timeoutMs?: number
}

/**
 * Instala dependências via npm ci se houver package-lock.json na raiz do worktree.
 *
 * Salvaguardas:
 * - Captura git status --porcelain antes/depois; se npm ci alterar arquivo rastreado, falha.
 * - Sem package-lock.json → pula (não roda npm install).
 * - Falha do npm ci → erro claro com trecho da saída, sem consumir escada de modelos.
 *
 * O runner é injetável para testes; em produção usa execSync (NodeCommandRunner).
 */
export class DependencyInstaller {
  private readonly runner: CommandRunner

  constructor(runner?: CommandRunner) {
    this.runner = runner ?? new NodeCommandRunner()
  }

  async install(input: InstallDependenciesInput): Promise<DependencyInstallOutcome> {
    const lockFile = join(input.worktreePath, "package-lock.json")
    if (!existsSync(lockFile)) {
      logger.info("npm ci pulado: package-lock.json não encontrado", { worktreePath: input.worktreePath })
      return { ok: true, skipped: true, reason: "package-lock.json ausente" }
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // Captura git status ANTES do npm ci
    let statusBefore: string
    try {
      const result = await this.runner.run("git status --porcelain", input.worktreePath, 30_000)
      statusBefore = result.stdout.trim()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn("Falha ao capturar git status antes do npm ci: " + msg)
      statusBefore = ""
    }

    logger.info("Executando npm ci (timeout: " + Math.round(timeoutMs / 1000) + "s)...", {
      worktreePath: input.worktreePath,
    })

    // Executa npm ci
    try {
      await this.runner.run("npm ci", input.worktreePath, timeoutMs)
      logger.info("npm ci concluído com sucesso")
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Trunca a saída para não poluir logs/eventos, mas mantém diagnóstico suficiente
      const excerpt = msg.substring(0, 1000)
      logger.error("npm ci falhou: " + excerpt)
      return {
        ok: false,
        reason: "npm ci falhou — " + excerpt,
      }
    }

    // Captura git status DEPOIS e compara
    let statusAfter: string
    try {
      const result = await this.runner.run("git status --porcelain", input.worktreePath, 30_000)
      statusAfter = result.stdout.trim()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn("Falha ao capturar git status depois do npm ci: " + msg)
      return { ok: true, skipped: false }
    }

    if (statusBefore !== statusAfter) {
      // Identifica linhas novas no status
      const beforeLines = new Set(statusBefore.split("\n").filter(Boolean))
      const newLines = statusAfter.split("\n").filter((line) => line && !beforeLines.has(line))
      // Filtra apenas mudanças em arquivos rastreados (linhas que NÃO começam com "??")
      const trackedChanges = newLines.filter((line) => !line.startsWith("??"))
      if (trackedChanges.length > 0) {
        const fileList = trackedChanges.slice(0, 10).join(", ")
        logger.error("npm ci modificou arquivos rastreados: " + fileList)
        return {
          ok: false,
          reason:
            "npm ci modificou arquivos rastreados: " +
            fileList +
            " — verifique se o package-lock.json está consistente com package.json",
        }
      }
    }

    return { ok: true, skipped: false }
  }
}

/**
 * Resolve o timeout de instalação de dependências a partir da variável de ambiente.
 * Exportado para testes e para uso direto no TaskWorker.
 */
export function resolveInstallTimeoutMs(): number {
  const envValue = process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS
  if (envValue) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_TIMEOUT_MS
}
