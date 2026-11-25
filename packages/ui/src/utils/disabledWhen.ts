/**
 * disabledWhen.ts — avaliador das condições `CustomAction.disabledWhen`.
 *
 * A expressão é uma TEMPLATE em runtime (contrato MANUAL_CONFIG_PROJETOS §3):
 * comparações de campos da linha com literais, combináveis com `&&` e `||`.
 * Exemplos:
 *   'status !== "pronta_retirada"'
 *   'status === "concluida" || status === "cancelada"'
 *   'a === 1 && b !== "x" || c === null'
 *
 * Semântica (idêntica à documentada no schema — shared/src/config.ts):
 * - avaliação somente contra a LINHA exibida; sem linha → `false` (não
 *   desabilita);
 * - campo ausente no registro → comparação `false`, EXCETO `=== null` e
 *   `=== undefined` (e negações simétricas: `!== null`/`!== undefined`
 *   sobre campo presente avaliam `true`);
 * - expressão não reconhecida → `false` (falha ABERTA: nunca desabilita por
 *   sintaxe inválida — preserva o comportamento anterior de ações sem
 *   condição e evita bloquear ações por typo em config);
 * - sem eval/Function: parser próprio, seguro contra conteúdo de config.
 *
 * Literais aceitos no lado direito: 'aspas simples', "aspas duplas",
 * `crase`, números (42, -1.5), true/false, null, undefined e token nu
 * (interpretado como string, ex.: `status === pronta_retirada`).
 */
import type { EntityRecord } from "../types"

/** Operador de comparação reconhecido. */
type Operador = "===" | "!=="

/** Literal já parseado (kind resolve a comparação com valor da linha). */
type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "undefined" }

const COMPARACAO_RE = /^([A-Za-z_][\w.]*)\s*(===|!==)\s*(.+)$/

function parsearLiteral(bruto: string): Literal | null {
  const t = bruto.trim()
  if (t.length === 0) return null
  for (const q of ["'", '"', "`"] as const) {
    if (t.startsWith(q) && t.endsWith(q) && t.length >= 2) {
      return { kind: "string", value: t.slice(1, -1) }
    }
  }
  if (t === "null") return { kind: "null" }
  if (t === "undefined") return { kind: "undefined" }
  if (t === "true") return { kind: "boolean", value: true }
  if (t === "false") return { kind: "boolean", value: false }
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return { kind: "number", value: Number(t) }
  // Token nu: string literal (ex.: status === pronta_retirada).
  return { kind: "string", value: t }
}

/**
 * Divide por operador top-level SEM cortar dentro de literais entre aspas.
 * Não usa regex sobre a expressão inteira para não quebrar em
 * `a === "x||y"`. Sem parênteses no contrato — só `&&`/`||` no topo.
 */
function dividirTop(expressao: string, operador: "&&" | "||"): string[] {
  const partes: string[] = []
  let atual = ""
  let aspas: string | null = null
  for (let i = 0; i < expressao.length; i++) {
    const ch = expressao[i]!
    if (aspas !== null) {
      atual += ch
      if (ch === aspas && expressao[i - 1] !== "\\") aspas = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      aspas = ch
      atual += ch
      continue
    }
    if (expressao.startsWith(operador, i)) {
      partes.push(atual)
      atual = ""
      i += operador.length - 1
      continue
    }
    atual += ch
  }
  partes.push(atual)
  return partes
}

/** Igualdade linha×literal com coerção de escalares simples (number/Date/bigint). */
function valoresIguais(valor: unknown, literal: Literal): boolean {
  if (valor === null || valor === undefined) {
    // Campo PRESENTE mas vazio: só null/undefined "batem" (docs não distinguem
    // campo ausente de campo null para o lado da linha; tratamos null==null).
    return literal.kind === "null" || literal.kind === "undefined"
  }
  if (literal.kind === "null" || literal.kind === "undefined") return false
  if (typeof valor === "boolean") return valor === literal.value
  if (typeof valor === "number") {
    return literal.kind === "number"
      ? valor === literal.value
      : String(valor) === String(literal.value)
  }
  if (valor instanceof Date) {
    return (
      literal.kind === "string" &&
      (valor.toISOString() === literal.value || valor.toISOString().slice(0, 10) === literal.value)
    )
  }
  if (typeof valor === "bigint") return String(valor) === String(literal.value)
  return String(valor) === String(literal.value)
}

/** Compara UMA expressão `campo <op> literal` contra a linha. */
function avaliarComparacao(termo: string, linha: EntityRecord): boolean {
  const match = COMPARACAO_RE.exec(termo.trim())
  if (!match) return false // sintaxe inválida → falha aberta
  const campo = match[1]!
  const operador = match[2] as Operador
  const ladoDireito = match[3]!
  const literal = parsearLiteral(ladoDireito)
  if (!literal) return false

  const ausente = !(campo in linha)
  if (ausente) {
    // Contrato documentado: campo ausente → false, exceto comparação com
    // null/undefined, que vale como "campo não preenchido".
    const ehVazio = literal.kind === "null" || literal.kind === "undefined"
    if (!ehVazio) return false
    return operador === "==="
  }
  const iguais = valoresIguais(linha[campo], literal)
  return operador === "===" ? iguais : !iguais
}

/**
 * Avalia a template `disabledWhen` contra a linha da grid.
 * `true` → botão da ação deve nascer desabilitado.
 */
export function avaliarDisabledWhen(
  expressao: string | undefined,
  linha: EntityRecord | undefined,
): boolean {
  if (!expressao || !expressao.trim()) return false
  if (!linha) return false // runtime só avalia contra a linha quando existe
  for (const grupo of dividirTop(expressao, "||")) {
    const termos = dividirTop(grupo, "&&")
    if (termos.length === 0) continue
    if (termos.every((termo) => avaliarComparacao(termo, linha))) {
      return true
    }
  }
  return false
}
