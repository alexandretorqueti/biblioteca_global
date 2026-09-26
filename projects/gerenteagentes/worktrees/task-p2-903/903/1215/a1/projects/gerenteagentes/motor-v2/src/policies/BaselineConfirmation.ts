/**
 * BaselineConfirmation — confirmação de falha INDEPENDENTE das alterações (P1, 2026-09-05).
 *
 * Problema (investigação tarefa 760, item 5): a "confirmação no workspace
 * intocado" era só uma re-execução do mesmo comando COM as alterações do
 * agente ainda aplicadas. Uma falha ambiental/baseline (teste obsoleto que já
 * falhava antes) era "confirmada" e atribuída ao código do agente → rework →
 * entregas queimadas num gate impossível.
 *
 * Solução (decisão Alexandre 2026-09-05): na confirmação, fazer `git stash`
 * das alterações do agente DENTRO do worktree, re-rodar o teste e restaurar.
 * - Falha SEM as alterações → `baseline_red` (ou `environment`) → não é culpa
 *   do agente: cria correção de baseline (híbrido opção c) ou bloqueia.
 * - Passa SEM as alterações → a falha depende das alterações → rejeição normal.
 *
 * O runner é injetável (forma de TaskWorker.exec: lança erro em exit != 0).
 */

export type SyncCommandRunner = (command: string, cwd: string, timeoutMs: number) => string

export interface BaselineConfirmationInput {
  repoPath: string
  /** Comando de confirmação (gate escopado nos arquivos que falharam). */
  confirmationCommand: string
  runner: SyncCommandRunner
  timeoutMs?: number
}

export type BaselineRedKind = "baseline_red" | "environment"

export interface BaselineConfirmationResult {
  /** True quando a falha se reproduz SEM as alterações do agente. */
  baselineRed: boolean
  /** Classificação da causa (relevante quando baselineRed=true). */
  kind?: BaselineRedKind
  /** Evidência textual para log/scope da correção de baseline. */
  evidence: string
  /** True quando houve stash (havia alterações para reverter). */
  stashApplied: boolean
}

/** Assinaturas de falha ambiental (infra), não corrigíveis por código/teste. */
const ENVIRONMENT_PATTERN =
  /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|Connection refused|command not found|spawn .* ENOENT|Cannot find module '(?!.*worktree)|docker: .*not found|ER_ACCESS_DENIED|Access denied for user)/i

export function classifyBaselineRedKind(failureOutput: string): BaselineRedKind {
  return ENVIRONMENT_PATTERN.test(failureOutput || "") ? "environment" : "baseline_red"
}

const STASH_MESSAGE = "motor-baseline-confirmation"

/**
 * Executa a confirmação com/sem alterações. Síncrono de propósito: o caller
 * (TaskWorker.phaseVerify) já opera com execSync e precisa garantir o
 * `stash pop` no mesmo ponto do fluxo.
 *
 * Lança erro SOMENTE se o estado do worktree ficar inconsistente (falha ao
 * restaurar as alterações) — nesse caso o caller deve tratar como bloqueio
 * ambiental, nunca como falha do agente.
 */
export function confirmBaselineIndependentFailure(input: BaselineConfirmationInput): BaselineConfirmationResult {
  const timeoutMs = input.timeoutMs ?? 300_000
  const status = input.runner("git status --porcelain", input.repoPath, 60_000).trim()

  if (!status) {
    // Sem alterações para reverter: o worktree JÁ está intocado. Rodar o
    // comando de confirmação aqui testa exatamente o baseline.
    try {
      input.runner(input.confirmationCommand, input.repoPath, timeoutMs)
      return {
        baselineRed: false,
        evidence: "Gate passou no workspace sem alterações (falha anterior não se reproduz — flake).",
        stashApplied: false,
      }
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error)
      return {
        baselineRed: true,
        kind: classifyBaselineRedKind(output),
        evidence: "Falha reproduzida no workspace SEM qualquer alteração do agente (nenhuma modificação pendente).",
        stashApplied: false,
      }
    }
  }

  input.runner(`git stash push -u -m ${STASH_MESSAGE}`, input.repoPath, 60_000)
  let baselineRed = false
  let evidence: string
  let failureOutput = ""
  try {
    input.runner(input.confirmationCommand, input.repoPath, timeoutMs)
    evidence = "Sem as alterações do agente o gate PASSA — a falha depende do código entregue (rejeição normal)."
  } catch (error) {
    baselineRed = true
    failureOutput = error instanceof Error ? error.message : String(error)
    evidence =
      "Falha reproduzida SEM as alterações do agente (verificado via git stash): " +
      "o gate já estava vermelho antes desta entrega — não é culpa do agente."
  } finally {
    try {
      input.runner("git stash pop", input.repoPath, 120_000)
    } catch (popError) {
      // Worktree inconsistente: as alterações do agente ficaram no stash. O
      // caller não pode continuar o rework nesse estado — trata como bloqueio
      // ambiental (o worktree da tentativa é descartável).
      throw new Error(
        "Ambiente bloqueado: falha ao restaurar alterações do agente após confirmação de baseline (git stash pop): " +
          (popError instanceof Error ? popError.message : String(popError)),
      )
    }
  }

  return baselineRed
    ? { baselineRed: true, kind: classifyBaselineRedKind(failureOutput), evidence, stashApplied: true }
    : { baselineRed: false, evidence, stashApplied: true }
}
