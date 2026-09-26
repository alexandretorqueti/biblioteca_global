import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import { evaluatePromotionConflictAnalysis } from "./PromotionConflictPolicy.js"
import type { PromotionConflictAnalyzerPort, PromotionConflictCandidate, PromotionConflictEvidence } from "./promotion-conflict.types.js"

function buildPrompt(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): string {
  const files = evidence.conflictFiles.map((file) => [
    `ARQUIVO: ${file.path}`,
    `CLASSIFICAÇÃO INICIAL: ${file.kind}`,
    "ANCESTRAL COMUM:", file.ancestorExcerpt || "(vazio/indisponível)",
    "BASE ATUAL:", file.baseExcerpt || "(vazio/indisponível)",
    "BRANCH DA TAREFA:", file.taskExcerpt || "(vazio/indisponível)",
  ].join("\n")).join("\n\n---\n\n")

  return [
    "Você é o analista técnico do Motor-v2. Analise um conflito de promoção tarefa→base.",
    "Não edite arquivos, não execute merge, não faça push e não sugira escolher ours/theirs integralmente.",
    `Tarefa: ${candidate.taskId}`,
    `Base: ${evidence.baseBranch} @ ${evidence.baseCommit}`,
    `Branch da tarefa: ${evidence.taskBranch} @ ${evidence.taskCommit}`,
    `Merge-base: ${evidence.mergeBase}`,
    "Para cada arquivo, explique: causa, mudanças que precisam ser preservadas dos dois lados, risco semântico, estratégia de composição e testes.",
    "Responda em português e termine com JSON: {\"confidence\":\"low|medium|high\",\"summary\":\"...\",\"files\":[...]}",
    files,
  ].join("\n\n")
}

export class PromotionConflictAnalyzer implements PromotionConflictAnalyzerPort {
  constructor(private readonly driver: ConsoleAgentRuntimeDriver) {}

  async analyze(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence) {
    const key = `motor:promotion-conflict:${candidate.taskId}:${evidence.fingerprint.slice(0, 12)}`
    const session = await this.driver.createSession({
      agentId: candidate.agentId,
      key,
      label: `Análise de conflito da tarefa ${candidate.taskId}`,
    })
    try {
      const { runId } = await this.driver.sendMessage({ session, message: buildPrompt(candidate, evidence), idempotencyKey: evidence.fingerprint })
      const completion = await this.driver.waitForRunCompletion(session, runId)
      if (completion.state !== "final" || !completion.content) {
        throw new Error("Analista não produziu relatório: " + (completion.errorMessage ?? completion.state))
      }
      return evaluatePromotionConflictAnalysis(completion.content, evidence)
    } finally {
      await this.driver.closeSession(session).catch(() => undefined)
    }
  }
}

