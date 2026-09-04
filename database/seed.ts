/**
 * Seed idempotente do database core + provisionamento dos projetos iniciais
 * (PoC §4.3/§9). Etapa 6:
 * - Config inicial = config.ts base da pasta do projeto + telas geradas do
 *   schema (montarConfigInicial), validada pelo contrato do shared.
 * - Provisiona os databases projeto_<id> e aplica as migrations de cada
 *   projeto (mesmo mecanismo do ciclo de vida — PoC §6.3).
 *
 * Idempotente: rodar N vezes não duplica nada; a senha do alexandre nunca é
 * sobrescrita após a primeira inserção.
 */
import argon2 from "argon2"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import mysql from "mysql2/promise"
import {
  coletarAnnotations,
  coletarTabelas,
  montarConfigInicial,
} from "@biblioteca-global/schema-tools"
import {
  geradorSistemaConfigSchema,
  type GeradorSistemaConfig,
} from "@biblioteca-global/shared"
import { loadEnv, type CoreEnv } from "./env"
import { projetos, projetosUsuarios, usuarios } from "./schema"

/** POC §9.3 — senha descartável; Alexandre troca no primeiro login. */
const SENHA_INICIAL_DESCARTAVEL = "Bo4MfU29r0GPi1"

export interface ProjetoSeed {
  nome: string
  slug: string
  configBase: GeradorSistemaConfig
  tabelas: ReturnType<typeof coletarTabelas>
  annotations: ReturnType<typeof coletarAnnotations>
}

interface ProjetoConfigModule {
  config?: unknown
}

/**
 * Descobre os projetos da plataforma por convenção.
 *
 * Projetos auxiliares podem existir em `projects/` sem participar da
 * plataforma; somente diretórios que possuem config.ts entram no seed.
 * Cada projeto é isolado em seu próprio try/catch para que uma configuração
 * inválida não impeça os demais de serem provisionados.
 */
export async function descobrirProjetosSeed(
  pastaProjects = resolve(__dirname, "..", "projects"),
): Promise<ProjetoSeed[]> {
  const projetosDescobertos: ProjetoSeed[] = []
  const entradas = readdirSync(pastaProjects, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )

  for (const entrada of entradas) {
    if (!entrada.isDirectory()) continue
    const slug = entrada.name
    const pasta = resolve(pastaProjects, slug)
    const caminhoConfig = resolve(pasta, "config.ts")
    const caminhoSchema = resolve(pasta, "schema.ts")
    if (!existsSync(caminhoConfig)) continue

    try {
      if (!existsSync(caminhoSchema)) {
        throw new Error("schema.ts ausente")
      }
      const moduloConfig = (await import(pathToFileURL(caminhoConfig).href)) as ProjetoConfigModule
      const configBase = geradorSistemaConfigSchema.parse(moduloConfig.config)
      const moduloSchema = (await import(pathToFileURL(caminhoSchema).href)) as Record<string, unknown>
      projetosDescobertos.push({
        nome: configBase.app.name,
        slug,
        configBase,
        tabelas: coletarTabelas(moduloSchema),
        annotations: coletarAnnotations(moduloSchema),
      })
    } catch (erro: unknown) {
      const detalhe = erro instanceof Error ? erro.message : String(erro)
      console.error(`Seed: projeto "${slug}" ignorado; config inválida ou não carregável: ${detalhe}`)
    }
  }

  return projetosDescobertos
}

/** Config inicial gerada (base versionada + telas do schema). */
export function configInicialDoProjeto(semente: ProjetoSeed): GeradorSistemaConfig {
  return geradorSistemaConfigSchema.parse(
    montarConfigInicial(semente.configBase, semente.tabelas, semente.annotations),
  )
}

async function garantirDatabaseProjeto(
  env: CoreEnv,
  database: string,
): Promise<void> {
  if (!/^projeto_[0-9]+$/.test(database)) {
    throw new Error(`nome de database inválido: ${database}`)
  }
  const usuario = env.MYSQL_USER.replace(/[`'\\]/g, "")
  const root = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: "root",
    password: env.MYSQL_ROOT_PASSWORD,
  })
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``)
    await root.query(
      `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${usuario}'@'%'`,
    )
    await root.query("FLUSH PRIVILEGES")
  } finally {
    await root.end()
  }
}

async function aplicarMigrationsDoProjeto(
  env: CoreEnv,
  slug: string,
  database: string,
): Promise<number> {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug}`)
  }
  const pasta = resolve(__dirname, "..", "projects", slug, "migrations")
  const journal = resolve(pasta, "meta", "_journal.json")
  if (!existsSync(journal)) {
    return 0
  }

  const conexao = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: "root",
    password: env.MYSQL_ROOT_PASSWORD,
    database,
  })
  try {
    const db = drizzle(conexao)
    await migrate(db, { migrationsFolder: pasta })
    const [linhas] = await conexao.query(
      "SELECT COUNT(*) AS total FROM __drizzle_migrations",
    )
    const primeira = (linhas as Array<{ total: number }>).at(0)
    return Number(primeira?.total ?? 0)
  } finally {
    await conexao.end()
  }
}

export async function seed(): Promise<void> {
  const env = loadEnv()
  const projetosSeed = await descobrirProjetosSeed()
  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
  const db = drizzle(connection)

  // 1) Projetos — upsert por slug, com a config inicial GERADA.
  for (const semente of projetosSeed) {
    const config = configInicialDoProjeto(semente)
    await db
      .insert(projetos)
      .values({
        nome: semente.nome,
        slug: semente.slug,
        ativo: true,
        config,
      })
      .onDuplicateKeyUpdate({
        set: { nome: semente.nome, ativo: true, config },
      })
  }

  // 2) Usuário alexandre — upsert por username; NUNCA sobrescreve a senha.
  const passwordHash = await argon2.hash(SENHA_INICIAL_DESCARTAVEL, {
    type: argon2.argon2id,
  })
  await db
    .insert(usuarios)
    .values({
      username: "alexandre",
      email: "alexandre.globaltecnologia@gmail.com",
      nome: "Alexandre",
      passwordHash,
      ativo: true,
    })
    .onDuplicateKeyUpdate({
      set: {
        nome: "Alexandre",
        email: "alexandre.globaltecnologia@gmail.com",
        ativo: true,
      },
    })

  // 3) Vínculos — admin em todos os projetos do seed.
  const alexandre = (
    await db
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(eq(usuarios.username, "alexandre"))
  ).at(0)
  if (!alexandre) {
    throw new Error("usuário alexandre não encontrado após o upsert")
  }

  const projetosCriados = await db
    .select({ id: projetos.id, slug: projetos.slug })
    .from(projetos)
    .where(inArray(projetos.slug, projetosSeed.map((p) => p.slug)))

  for (const projeto of projetosCriados) {
    await db
      .insert(projetosUsuarios)
      .values({
        projetoId: projeto.id,
        usuarioId: alexandre.id,
        perfil: "admin",
      })
      .onDuplicateKeyUpdate({ set: { perfil: "admin" } })
  }

  // 4) Provisionamento dos databases dos projetos (PoC §6.3).
  for (const projeto of projetosCriados) {
    const database = `projeto_${projeto.id}`
    await garantirDatabaseProjeto(env, database)
    const migrations = await aplicarMigrationsDoProjeto(
      env,
      projeto.slug,
      database,
    )
    console.log(`  ${projeto.slug}: database ${database} (${migrations} migration(s))`)
  }

  // 5) Resumo.
  const vinculos = await db
    .select({ perfil: projetosUsuarios.perfil })
    .from(projetosUsuarios)
    .where(eq(projetosUsuarios.usuarioId, alexandre.id))

  console.log(
    `Seed concluído: ${projetosCriados.length} projetos (${projetosCriados
      .map((p) => p.slug)
      .join(", ")}), usuário alexandre (id ${alexandre.id}) com ` +
      `${vinculos.length} vínculos admin.`,
  )
  await connection.end()
}

if (require.main === module) {
  seed().catch((erro: unknown) => {
    console.error("Seed falhou:", erro)
    process.exitCode = 1
  })
}
