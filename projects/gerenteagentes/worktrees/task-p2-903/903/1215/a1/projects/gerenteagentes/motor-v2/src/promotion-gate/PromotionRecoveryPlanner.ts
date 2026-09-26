import type { PromotionGateIssue } from "./PromotionGateVerifier.js"

/** Pedido declarativo. Quem persiste a subtarefa é outra camada. */
export interface PromotionRecoveryRequest {
  fingerprint: string
  title: string
  scope: string
  acceptanceCriteria: string[]
}

/** Transforma achados técnicos em uma correção limitada e verificável. */
export function planPromotionRecovery(issues: readonly PromotionGateIssue[]): PromotionRecoveryRequest | null {
  if (issues.length === 0) return null
  const evidence = issues.map((issue) => `- [${issue.kind}] ${issue.message}\n  Evidência: ${issue.evidence}`).join("\n")
  const fingerprint = [...new Set(issues.map((issue) => issue.fingerprint))].sort().join("|").slice(0, 480)
  return {
    fingerprint: `promotion-gate:${fingerprint}`,
    title: "Correção automática: gate de promoção",
    scope: [
      "Corrigir exclusivamente os achados do gate de promoção abaixo, sem ampliar o escopo funcional da tarefa.",
      "Atualize migrations e journal quando necessário; não altere dados de produção manualmente.",
      "Achados:", evidence,
    ].join("\n"),
    acceptanceCriteria: [
      "Todas as migrations existentes estão registradas no journal.",
      "Cada tabela/coluna exigida pelo código possui migration aplicável.",
      "O gate de promoção volta a passar contra a base atual.",
    ],
  }
}
