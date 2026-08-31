/**
 * Carrega variáveis do .env da raiz do repositório.
 * process.env tem precedência (permite override pontual, ex.:
 * MYSQL_HOST=host.docker.internal para rodar migrations de dentro de container).
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const CHAVES_ENV = [
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "MYSQL_DATABASE",
] as const

export type ChaveEnv = (typeof CHAVES_ENV)[number]
export type CoreEnv = Record<ChaveEnv, string>

export function loadEnv(): CoreEnv {
  // database/ é escopo CommonJS (package.json próprio) — __dirname disponível.
  const envPath = resolve(__dirname, "..", ".env")

  const doArquivo: Record<string, string> = {}
  if (existsSync(envPath)) {
    for (const linha of readFileSync(envPath, "utf8").split("\n")) {
      const limpa = linha.trim()
      if (!limpa || limpa.startsWith("#")) continue
      const corte = limpa.indexOf("=")
      if (corte < 1) continue
      doArquivo[limpa.slice(0, corte)] = limpa.slice(corte + 1)
    }
  }

  const faltando: string[] = []
  const env = {} as CoreEnv
  for (const chave of CHAVES_ENV) {
    const valor = process.env[chave] ?? doArquivo[chave]
    if (!valor) {
      faltando.push(chave)
      continue
    }
    env[chave] = valor
  }

  if (faltando.length > 0) {
    throw new Error(
      `Variáveis ausentes: ${faltando.join(", ")} — copie .env.example para .env e ajuste.`,
    )
  }
  return env
}
