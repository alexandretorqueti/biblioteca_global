/**
 * Fusão pura de conflitos em arquivos de registro aditivos.
 *
 * A âncora de uma inserção é a quantidade de linhas da base que já foram
 * consumidas antes dela. Inserções no mesmo ponto são ordenadas pelo conteúdo
 * (comparação lexicográfica por unidades UTF-16), independentemente do lado
 * que as produziu. Linhas inseridas idênticas são mantidas uma única vez.
 *
 * O algoritmo só aceita variantes que contêm a base inteira como subsequência:
 * assim, deleção ou edição de qualquer linha existente torna o conflito
 * não-aditivo. A quebra de linha precisa ser compatível e os dois lados devem
 * concordar sobre o newline final; em caso contrário a fusão retorna null para
 * o chamador usar o fallback.
 */

export type AdditiveConflictClassification = 'puramente aditivo' | 'não-aditivo'

interface ParsedText {
  lines: string[]
  newline: string | null
  finalNewline: boolean
}

interface Insertion {
  anchor: number
  line: string
  side: 0 | 1
}

interface VariantAnalysis {
  insertions: Insertion[]
}

function parseText(raw: string): ParsedText {
  const finalNewline = /(?:\r\n|\r|\n)$/.test(raw)
  const newlineMatches = raw.match(/\r\n|\r|\n/g) ?? []
  const newline = newlineMatches[0] ?? null
  const parts = raw.split(/\r\n|\r|\n/)
  if (finalNewline) parts.pop()
  return { lines: parts, newline, finalNewline }
}

function analyzeVariant(base: string[], variant: string[], side: 0 | 1): VariantAnalysis | null {
  const insertions: Insertion[] = []
  let baseIndex = 0

  for (const line of variant) {
    if (baseIndex < base.length && line === base[baseIndex]) {
      baseIndex += 1
    } else {
      insertions.push({ anchor: baseIndex, line, side })
    }
  }

  // A variant that does not contain every base line deleted or edited one.
  if (baseIndex !== base.length) return null
  return { insertions }
}

function compatibleNewline(base: ParsedText, ours: ParsedText, theirs: ParsedText): string | null {
  const styles = [base.newline, ours.newline, theirs.newline].filter((value): value is string => value !== null)
  if (styles.length === 0) return ''
  if (styles.some(style => style !== styles[0])) return null

  if (ours.finalNewline !== theirs.finalNewline) return null
  return styles[0]!
}

function analyze(rawBase: string, rawVariant: string, side: 0 | 1): VariantAnalysis | null {
  const base = parseText(rawBase)
  const variant = parseText(rawVariant)
  return analyzeVariant(base.lines, variant.lines, side)
}

export function detectAdditiveConflict(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): AdditiveConflictClassification {
  const base = parseText(baseRaw)
  return analyzeVariant(base.lines, parseText(oursRaw).lines, 0) !== null
    && analyzeVariant(base.lines, parseText(theirsRaw).lines, 1) !== null
    ? 'puramente aditivo'
    : 'não-aditivo'
}

export function mergeAdditive(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): string | null {
  const base = parseText(baseRaw)
  const ours = parseText(oursRaw)
  const theirs = parseText(theirsRaw)
  const newline = compatibleNewline(base, ours, theirs)
  if (newline === null) return null

  const oursAnalysis = analyze(baseRaw, oursRaw, 0)
  const theirsAnalysis = analyze(baseRaw, theirsRaw, 1)
  if (oursAnalysis === null || theirsAnalysis === null) return null

  const insertions = [...oursAnalysis.insertions, ...theirsAnalysis.insertions]
    .sort((left, right) => {
      if (left.anchor !== right.anchor) return left.anchor - right.anchor
      if (left.line !== right.line) return left.line < right.line ? -1 : 1
      return left.side - right.side
    })

  const seen = new Set<string>()
  const mergedInsertions = new Map<number, string[]>()
  for (const insertion of insertions) {
    if (seen.has(insertion.line)) continue
    seen.add(insertion.line)
    const atAnchor = mergedInsertions.get(insertion.anchor) ?? []
    atAnchor.push(insertion.line)
    mergedInsertions.set(insertion.anchor, atAnchor)
  }

  const mergedLines: string[] = []
  for (let anchor = 0; anchor <= base.lines.length; anchor += 1) {
    mergedLines.push(...(mergedInsertions.get(anchor) ?? []))
    if (anchor < base.lines.length) mergedLines.push(base.lines[anchor]!)
  }

  return mergedLines.join(newline) + (ours.finalNewline ? newline : '')
}
