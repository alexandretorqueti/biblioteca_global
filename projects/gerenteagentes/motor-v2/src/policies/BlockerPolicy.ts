import { failureFingerprint } from './SystemFailurePolicy.js'

export type BlockerKind = 'blocked_environment' | 'systemic_failure' | 'model_chain_exhausted'

export interface BlockerEvidence {
  kind: BlockerKind
  fingerprint: string
  excerpt: string
}

export function blockerEvidence(kind: BlockerKind, reason: string): BlockerEvidence {
  return { kind, fingerprint: failureFingerprint(reason), excerpt: reason.trim().slice(0, 500) }
}
