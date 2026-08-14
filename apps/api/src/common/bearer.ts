/** Extrai o token Bearer do header Authorization. */
export function extractBearer(
  authorization: string | string[] | undefined,
): string | undefined {
  const valor = Array.isArray(authorization) ? authorization.at(0) : authorization
  if (!valor) return undefined
  const [esquema, token] = valor.split(" ")
  if (esquema?.toLowerCase() !== "bearer" || !token) return undefined
  return token
}
