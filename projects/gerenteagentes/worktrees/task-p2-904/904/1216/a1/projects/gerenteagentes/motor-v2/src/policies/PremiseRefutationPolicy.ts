import { existsSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { createHash } from "node:crypto"

export type PremiseConflictType = "source_of_truth_conflict" | "missing_prerequisite" | "scope_mismatch" | "acceptance_conflict" | "already_satisfied"
export interface PremiseEvidence { path: string; observation: string }
export interface PremiseRefutation {
  claim: string
  conflictType: PremiseConflictType
  evidence: PremiseEvidence[]
  suggestedRevision: string
}

const TYPES = new Set<PremiseConflictType>(["source_of_truth_conflict", "missing_prerequisite", "scope_mismatch", "acceptance_conflict", "already_satisfied"])

export function validatePremiseRefutation(value: unknown, workspace: string): { ok: true; refutation: PremiseRefutation; fingerprint: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object") return { ok: false, reason: "refutação ausente" }
  const raw = value as Record<string, unknown>
  const claim = typeof raw.claim === "string" ? raw.claim.trim() : ""
  const suggestedRevision = typeof raw.suggested_revision === "string" ? raw.suggested_revision.trim() : ""
  const conflictType = raw.conflict_type as PremiseConflictType
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : []
  if (claim.length < 10 || suggestedRevision.length < 10 || !TYPES.has(conflictType)) return { ok: false, reason: "claim, conflict_type ou suggested_revision inválido" }
  if (evidence.length === 0 || evidence.length > 8) return { ok: false, reason: "informe de 1 a 8 evidências" }
  const normalized: PremiseEvidence[] = []
  const root = resolve(workspace)
  for (const item of evidence) {
    if (!item || typeof item !== "object") return { ok: false, reason: "evidência inválida" }
    const candidate = item as Record<string, unknown>
    const path = typeof candidate.path === "string" ? candidate.path.trim() : ""
    const observation = typeof candidate.observation === "string" ? candidate.observation.trim() : ""
    if (!path || observation.length < 5 || isAbsolute(path)) return { ok: false, reason: "evidência exige caminho relativo e observação" }
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (rel.startsWith("..") || !existsSync(absolute) || !statSync(absolute).isFile()) return { ok: false, reason: `arquivo citado não existe no workspace: ${path}` }
    normalized.push({ path: rel, observation })
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ claim, conflictType, normalized })).digest("hex")
  return { ok: true, refutation: { claim, conflictType, evidence: normalized, suggestedRevision }, fingerprint }
}
