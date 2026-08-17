// @vitest-environment node
/**
 * Teste de seed — garante que:
 * - O usuário alexandre existe com e-mail alexandre.globaltecnologia@gmail.com
 * - O projeto piloto gerenteagentes foi provisionado
 * - O pivot projetos_usuarios tem perfil ADMIN para alexandre no gerenteagentes
 * - Rodar seed N vezes é idempotente (segunda chamada não quebra)
 */
import mysql from "mysql2/promise"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seed } from "../seed.js"
import { loadEnv } from "../env.js"

let connection: mysql.Connection
let env: ReturnType<typeof loadEnv>

beforeAll(async () => {
  env = loadEnv()
  connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
})

afterAll(async () => {
  await connection.end()
})

describe("seed — gerenteagentes piloto", () => {
  it("executa sem erro e é idempotente (rodada dupla)", async () => {
    // Roda duas vezes — a segunda deve ser inócua, não quebrar.
    await seed()
    await seed()
    expect(true).toBe(true)
  })

  it("cria usuário alexandre com e-mail correto", async () => {
    const [linhas] = await connection.query(
      "SELECT username, email FROM usuarios WHERE username = ?",
      ["alexandre"],
    )
    const rows = linhas as Array<{ username: string; email: string }>
    expect(rows.length).toBeGreaterThan(0)
    const alexandre = rows.find((r) => r.username === "alexandre")
    expect(alexandre).toBeDefined()
    expect(alexandre!.email).toBe("alexandre.globaltecnologia@gmail.com")
  })

  it("cria projeto gerenteagentes no seed", async () => {
    const [linhas] = await connection.query(
      "SELECT id, slug FROM projetos WHERE slug = ?",
      ["gerenteagentes"],
    )
    const rows = linhas as Array<{ id: number; slug: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.at(0)!.slug).toBe("gerenteagentes")
  })

  it("pivot ADMIN para alexandre no gerenteagentes", async () => {
    const [projetosLinhas] = await connection.query(
      "SELECT id FROM projetos WHERE slug = ?",
      ["gerenteagentes"],
    )
    const projRows = projetosLinhas as Array<{ id: number }>
    expect(projRows.length).toBeGreaterThan(0)
    expect(projRows.at(0)!.id).toBeTypeOf("number")

    const [alexandreLinhas] = await connection.query(
      "SELECT id FROM usuarios WHERE username = ?",
      ["alexandre"],
    )
    const alexRows = alexandreLinhas as Array<{ id: number }>
    expect(alexRows.length).toBeGreaterThan(0)
    expect(alexRows.at(0)!.id).toBeTypeOf("number")

    const [vinculos] = await connection.query(
      "SELECT perfil FROM projetos_usuarios WHERE usuario_id = ? AND projeto_id = ?",
      [alexRows.at(0)!.id, projRows.at(0)!.id],
    )
    const vincRows = vinculos as Array<{ perfil: string }>
    expect(vincRows.length).toBeGreaterThan(0)
    expect(vincRows.at(0)?.perfil).toBe("admin")
  })

  it("inclui gerenteagentes na lista de projetos do seed", async () => {
    const [linhas] = await connection.query(
      "SELECT slug FROM projetos WHERE slug IN (?, ?, ?) ORDER BY slug",
      ["biblioteca-global", "documentacao", "gerenteagentes"],
    )
    const rows = linhas as Array<{ slug: string }>
    expect(rows.length).toBe(3)
    const slugs = rows.map((r) => r.slug).sort()
    expect(slugs).toEqual(["biblioteca-global", "documentacao", "gerenteagentes"])
  })
})
