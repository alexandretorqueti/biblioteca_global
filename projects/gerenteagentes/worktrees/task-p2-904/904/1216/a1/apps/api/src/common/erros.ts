/** Erros de banco mapeados para HTTP. */

export function ehErroDuplicado(erro: unknown): boolean {
  const info = erro as { code?: string; cause?: { code?: string } }
  return (
    info.code === "ER_DUP_ENTRY" || info.cause?.code === "ER_DUP_ENTRY"
  )
}

/** Database do projeto ainda não provisionado. */
export function ehErroDatabaseAusente(erro: unknown): boolean {
  const info = erro as { code?: string; cause?: { code?: string } }
  return (
    info.code === "ER_BAD_DB_ERROR" ||
    info.cause?.code === "ER_BAD_DB_ERROR"
  )
}
