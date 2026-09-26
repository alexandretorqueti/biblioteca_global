import { isPromotionBlocker } from "../policies/PromotionBlockers.js"
import { isSystemBlocker, SYSTEM_BLOCK_COOLDOWN_SECONDS, SYSTEM_BLOCK_MAX_AUTO_RETRIES } from "../policies/SystemBlockers.js"

/** Valores persistidos no contrato da API; não renomear sem versionamento. */
export enum RecoveryEligibilityState {
  Eligible = "eligible",
  Cooldown = "cooldown",
  MonitorCorrecting = "monitor_correcting",
  AwaitingUser = "awaiting_user",
  MaxRetries = "max_retries",
  PromotionBlocked = "promotion_blocked",
}

export interface RecoveryBlockerEvidence {
  id?: number
  subtarefaId?: number | null
  reason: string
  command?: string
  excerpt?: string
  blockedAt?: Date | string | null
  orphan?: boolean
}

export interface RecoveryActiveLease {
  executionId: string
  ownerId: string
  resourceKey: string
  expiresAt: Date | string
}

export interface RecoveryPendingQuestion {
  messageId?: number
  askedAt: Date | string
  text?: string
}

export interface RecoveryEligibilityFacts {
  status: string
  blockers: readonly RecoveryBlockerEvidence[]
  resolvedSystemBlockCount24h: number
  activeLease?: RecoveryActiveLease | null
  pendingQuestion?: RecoveryPendingQuestion | null
  now?: Date
}

export interface RecoveryEligibility {
  state: RecoveryEligibilityState
  label: string
  reason: string
  evidence: RecoveryBlockerEvidence | null
  cooldown: { secondsRemaining: number; seconds: number } | null
  attempts: { resolvedLast24h: number; max: number } | null
  lease: RecoveryActiveLease | null
  pendingQuestion: RecoveryPendingQuestion | null
  promotionBlocker: RecoveryBlockerEvidence | null
}

const seconds = (value: Date | string, now: Date): number => Math.max(0, Math.ceil((new Date(value).getTime() + SYSTEM_BLOCK_COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000))

/** Verificador puro. A ordem aqui é o contrato canônico do selo/tooltip. */
export function verifyRecoveryEligibility(facts: RecoveryEligibilityFacts): RecoveryEligibility | null {
  if (facts.status !== "blocked") return null
  const now = facts.now ?? new Date()
  const promotionBlocker = facts.blockers.find((blocker) => isPromotionBlocker(blocker.command ?? "", blocker.excerpt ?? "")) ?? null
  const systemBlocker = facts.blockers.find((blocker) => blocker.orphan || isSystemBlocker(blocker.reason, blocker.command, blocker.excerpt)) ?? null
  const lease = facts.activeLease && new Date(facts.activeLease.expiresAt).getTime() > now.getTime() ? facts.activeLease : null

  if (promotionBlocker) return result(RecoveryEligibilityState.PromotionBlocked, "Não elegível: bloqueio de promoção", "bloqueio de promoção exige o fluxo próprio", promotionBlocker, facts, null, lease, promotionBlocker)
  if (lease?.resourceKey === "motor:monitor" && lease.ownerId) return result(RecoveryEligibilityState.MonitorCorrecting, "Monitor corrigindo", "há um lease válido do Monitor", systemBlocker, facts, null, lease, null)
  if (facts.pendingQuestion) return result(RecoveryEligibilityState.AwaitingUser, "Aguardando sua resposta", "a última pergunta do Monitor ainda não foi respondida", systemBlocker, facts, null, null, null)
  if (facts.resolvedSystemBlockCount24h >= SYSTEM_BLOCK_MAX_AUTO_RETRIES) return result(RecoveryEligibilityState.MaxRetries, "Limite de recuperações atingido", "limite de recuperações automáticas nas últimas 24 horas atingido", systemBlocker, facts, null, null, null)

  const remaining = systemBlocker?.blockedAt ? seconds(systemBlocker.blockedAt, now) : 0
  if (remaining > 0) {
    return result(RecoveryEligibilityState.Cooldown, `Em carência — ${remaining}s`, `carência de ${SYSTEM_BLOCK_COOLDOWN_SECONDS}s após bloqueio sistêmico`, systemBlocker, facts, { secondsRemaining: remaining, seconds: SYSTEM_BLOCK_COOLDOWN_SECONDS }, null, null)
  }
  return result(RecoveryEligibilityState.Eligible, "Elegível para correção automática", "bloqueio sistêmico/órfão sem carência, lease ou limite", systemBlocker, facts, { secondsRemaining: 0, seconds: SYSTEM_BLOCK_COOLDOWN_SECONDS }, null, null)
}

function result(state: RecoveryEligibilityState, label: string, reason: string, evidence: RecoveryBlockerEvidence | null, facts: RecoveryEligibilityFacts, cooldown: RecoveryEligibility["cooldown"], lease: RecoveryActiveLease | null, promotionBlocker: RecoveryBlockerEvidence | null): RecoveryEligibility {
  return { state, label, reason, evidence, cooldown, attempts: { resolvedLast24h: facts.resolvedSystemBlockCount24h, max: SYSTEM_BLOCK_MAX_AUTO_RETRIES }, lease, pendingQuestion: facts.pendingQuestion ?? null, promotionBlocker }
}
