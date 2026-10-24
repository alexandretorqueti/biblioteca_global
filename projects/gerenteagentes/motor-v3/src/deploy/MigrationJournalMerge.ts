/**
 * Merge automático de `migrations/meta/_journal.json` em conflitos de
 * cherry-pick no compose do batch de deploy.
 *
 * Causa raiz (5 colisões em 2026-10-23 — tarefas 1033, 1040, 1041, 1034, 1042):
 * tarefas paralelas criam migrations com o MESMO índice numérico (ex.: duas
 * `0094_*`). O cherry-pick conflita apenas no journal; a resolução manual era
 * rebase + renumeração. Aqui o compose renumera automaticamente a migration
 * do membro para o próximo índice livre e segue com o lote.
 *
 * Contrato:
 * - `ours`  = journal da base composta até agora (HEAD do worktree);
 * - `base`  = journal no merge-base do cherry-pick (pode ser add/add → vazio);
 * - `theirs`= journal do commit do membro.
 * Entradas novas do membro (tag ausente no `base`) são renumeradas para
 * idx/when livres e anexadas ao `ours`. Retorna também os renomeios de tag
 * (arquivo `.sql` e snapshot `NNNN_snapshot.json`) que o chamador deve aplicar.
 */

export interface JournalEntry {
  idx: number
  version?: string
  when: number
  tag: string
  breakpoints?: boolean
}

export interface DrizzleJournal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

export interface JournalMergeResult {
  journal: DrizzleJournal
  /** Renomeios necessários: tag antiga → tag nova (índice renumerado). */
  renames: Array<{ from: string; to: string; oldIdx: number; newIdx: number }>
}

const TAG_PREFIX = /^(\d+)(_.*)$/

export function parseJournal(raw: string | null | undefined): DrizzleJournal | null {
  if (!raw || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as DrizzleJournal
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

/** `0094_foo` com idx 98 → `0098_foo` (mantém o corpo do nome). */
export function renumberTag(tag: string, newIdx: number): string {
  const match = TAG_PREFIX.exec(tag)
  const padded = String(newIdx).padStart(4, '0')
  return match ? `${padded}${match[2]}` : `${padded}_${tag}`
}

/**
 * Combina o journal atual (ours) com as entradas novas do membro (theirs−base),
 * renumerando idx/when para valores livres e monotônicos.
 * Retorna null quando os journals são inválidos ou há ambiguidade irrecuperável.
 */
export function mergeJournals(
  oursRaw: string | null,
  baseRaw: string | null,
  theirsRaw: string | null,
): JournalMergeResult | null {
  const ours = parseJournal(oursRaw)
  const theirs = parseJournal(theirsRaw)
  if (!ours || !theirs) return null
  // base ausente (add/add) → todas as entradas do theirs são novas.
  const base = parseJournal(baseRaw)
  const baseTags = new Set((base?.entries ?? []).map(entry => entry.tag))
  const oursTags = new Set(ours.entries.map(entry => entry.tag))

  const memberNew = theirs.entries.filter(entry => !baseTags.has(entry.tag) && !oursTags.has(entry.tag))
  if (memberNew.length === 0) {
    // Nada novo (tags já presentes em ours): journal ours já é o resultado.
    return { journal: ours, renames: [] }
  }

  let maxIdx = ours.entries.reduce((max, entry) => Math.max(max, entry.idx), -1)
  let maxWhen = ours.entries.reduce((max, entry) => Math.max(max, Number(entry.when) || 0), 0)
  const mergedEntries: JournalEntry[] = [...ours.entries]
  const renames: JournalMergeResult['renames'] = []

  // Ordem original do membro preservada (idx crescente no journal deles).
  for (const entry of [...memberNew].sort((a, b) => a.idx - b.idx)) {
    const newIdx = maxIdx + 1
    maxIdx = newIdx
    // when monotônico: preserva o `when` do membro quando já é maior (histórico
    // real), senão avança 1ms para garantir ordem de aplicação após as da base.
    const newWhen = Math.max(Number(entry.when) || 0, maxWhen + 1)
    maxWhen = newWhen
    const newTag = renumberTag(entry.tag, newIdx)
    if (newTag !== entry.tag) {
      renames.push({ from: entry.tag, to: newTag, oldIdx: entry.idx, newIdx })
    }
    mergedEntries.push({ ...entry, idx: newIdx, when: newWhen, tag: newTag })
  }

  return {
    journal: { version: ours.version ?? theirs.version, dialect: ours.dialect ?? theirs.dialect, entries: mergedEntries },
    renames,
  }
}

/** Nome do snapshot drizzle correspondente a um idx (`meta/0098_snapshot.json`). */
export function snapshotNameForIdx(idx: number): string {
  return `${String(idx).padStart(4, '0')}_snapshot.json`
}
