/**
 * Conversões `Date` ↔ texto de coluna MySQL DATETIME (macro 4, subtarefa 3).
 *
 * `regras_recorrencia.proxima_geracao` é `datetime(..., { mode: "string" })`
 * no schema do projeto (contrato do CRUD genérico trafega datas como string).
 * O agendador compara/grava esse cursor, então precisa de um formato canônico
 * estável: "YYYY-MM-DD HH:MM:SS" em horário LOCAL do processo (a suíte raiz
 * roda com TZ=UTC — vitest.config.ts — e o cálculo da subtarefa 1 também é
 * local, portanto os três falam o mesmo relógio).
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** `Date` → "YYYY-MM-DD HH:MM:SS" local (formato de coluna DATETIME do MySQL). */
export function formatarDatetimeMysql(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/**
 * Texto DATETIME → `Date` local. Aceita "YYYY-MM-DD HH:MM:SS" (formato do
 * MySQL), ISO com "T" e `Date` cru (mysql2 pode devolver objeto Date mesmo
 * com mode "string" — a função é tolerante à variação do driver).
 */
export function parseDatetimeMysql(valor: string | Date): Date {
  if (valor instanceof Date) return valor
  return new Date(valor.includes("T") ? valor : valor.replace(" ", "T"))
}
