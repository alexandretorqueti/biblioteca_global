/** Inicialização exclusiva do ambiente dev: schema + somente o administrador. */
import argon2 from "argon2"
import mysql from "mysql2/promise"
import { seed } from "./seed"
import { loadEnv } from "./env"

const env = loadEnv()
const password = process.env.DEV_ADMIN_PASSWORD?.trim()
if (!password) throw new Error("DEV_ADMIN_PASSWORD é obrigatório no ambiente dev")
const adminPassword: string = password

async function main(): Promise<void> {
  await seed()

  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
  try {
    const hash = await argon2.hash(adminPassword, { type: argon2.argon2id })
    await connection.execute(
      "UPDATE usuarios SET password_hash = ? WHERE username = 'alexandre'",
      [hash],
    )
    console.log("Administrador dev criado/atualizado: alexandre")
  } finally {
    await connection.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
