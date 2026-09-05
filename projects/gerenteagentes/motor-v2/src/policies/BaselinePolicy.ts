/**
 * BaselinePolicy — verificação de baseline antes da primeira subtarefa.
 *
 * Decisão (2026-08-31, Alexandre): antes de executar a primeira subtarefa de
 * uma tarefa, o motor roda a suíte completa na branch-base. Se estiver
 * vermelha, cria automaticamente uma subtarefa de correção de testes na
 * MESMA posição (a original é rejeitada com o motivo e volta depois), em vez
 * de queimar tentativas de execução contra um gate impossível.
 */

export const BASELINE_FINGERPRINT_PREFIX = "baseline:"
export const BASELINE_CORRECTION_TITLE = "Correção de baseline: suíte de testes vermelha"

export function isBaselineCorrection(correctionFingerprint?: string | null): boolean {
  return typeof correctionFingerprint === "string" && correctionFingerprint.startsWith(BASELINE_FINGERPRINT_PREFIX)
}

/**
 * Scope da subtarefa de correção de baseline: motivo da falha + instruções +
 * escopo original da subtarefa que seria executada (nada se perde).
 */
export function baselineCorrectionScope(
  failureReason: string, originalScope?: string, originalTitulo?: string): string {
  return [
    "A suíte de testes do repositório está VERMELHA na branch-base, antes de qualquer alteração desta tarefa.",
    "Corrija os testes e/ou o código necessários para a suíte completa ficar verde.",
    "Não implemente funcionalidades novas nesta subtarefa — apenas estabilize a suíte.",
    "",
    "Falha observada no baseline:",
    failureReason,
    "",
    "Escopo original da subtarefa que será executada depois desta correção:",
    originalScope || originalTitulo || "N/A",
  ].join("\n")
}

export const BASELINE_CORRECTION_CRITERION = "A suíte completa de testes do repositório passa sem erros (comando de teste do projeto)"

/**
 * Exclusões de teste do gate automático (2026-08-31, estendido 2026-09-04):
 * specs funcionais usam MySQL real + estado de seed e não são confiáveis como
 * gate automático — a suíte funcional vermelha no container bloqueou o
 * baseline da tarefa 731, e o gate escopado voltou a incluir uma spec
 * funcional obsoleta na tarefa 760 (7 entregas queimadas num gate
 * impossível). Decisão 2026-09-04 (Alexandre): specs funcionais NÃO são
 * gate automático em hipótese alguma (baseline, gate escopado ou correção
 * de baseline). Elas continuam no `npm run test` completo (humanos/CI).
 */
export const BASELINE_TEST_EXCLUDES: readonly string[] = ["**/*.functional.spec.ts"]

const FUNCTIONAL_SPEC_PATTERN = /\.functional\.spec\.[^/]+$/

/** True para specs funcionais (exclusão do gate automático — ver BASELINE_TEST_EXCLUDES). */
export function isFunctionalSpec(path: string): boolean {
  return FUNCTIONAL_SPEC_PATTERN.test(path.replace(/\\/g, "/"))
}

/** Anexa as exclusões do baseline a um comando de teste vitest/npm. */
export function withBaselineExcludes(testCommand: string): string {
  if (!/^(npm run test|npx vitest|vitest)\b/.test(testCommand.trim())) return testCommand
  return testCommand + BASELINE_TEST_EXCLUDES.map((pattern) => ` --exclude "${pattern}"`).join("")
}
