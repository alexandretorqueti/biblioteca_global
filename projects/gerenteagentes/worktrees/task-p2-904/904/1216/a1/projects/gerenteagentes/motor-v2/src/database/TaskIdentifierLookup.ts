/**
 * Monta a busca compatível com os dois identificadores públicos de uma tarefa.
 * O ID interno só é comparado quando a entrada é estritamente numérica; isso
 * evita warnings do MySQL e impede coerção de identificadores textuais.
 */
export function taskIdentifierLookup(taskId: string, alias = ""): { sql: string; params: unknown[] } {
  const prefix = alias ? `${alias}.` : ""
  if (/^\d+$/.test(taskId)) {
    return {
      sql: `(${prefix}external_id = ? OR ${prefix}id = ?)`,
      params: [taskId, Number(taskId)],
    }
  }
  return { sql: `${prefix}external_id = ?`, params: [taskId] }
}
