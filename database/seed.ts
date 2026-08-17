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
import { existsSync } from "node:fs"
import { resolve } from "node:path"
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

import { config as configBibliotecaGlobal } from "../projects/biblioteca-global/config"
import * as schemaBibliotecaGlobal from "../projects/biblioteca-global/schema"
import { config as configDocumentacao } from "../projects/documentacao/config"
import * as schemaDocumentacao from "../projects/documentacao/schema"
import { config as configGerenteAgentes } from "../projects/gerenteagentes/config"
import * as schemaGerenteAgentes from "../projects/gerenteagentes/schema"

/** POC §9.3 — senha descartável; Alexandre troca no primeiro login. */
const SENHA_INICIAL_DESCARTAVEL = "Bo4MfU29r0GPi1"

interface ProjetoSeed {
  nome: string
  slug: string
  configBase: GeradorSistemaConfig
  tabelas: ReturnType<typeof coletarTabelas>
  annotations: ReturnType<typeof coletarAnnotations>
}

const PROJETOS_SEED: ProjetoSeed[] = [
  {
    nome: "Biblioteca Global",
    slug: "biblioteca-global",
    configBase: configBibliotecaGlobal,
    tabelas: coletarTabelas(schemaBibliotecaGlobal),
    annotations: coletarAnnotations(schemaBibliotecaGlobal),
  },
  {
    nome: "Documentação",
    slug: "documentacao",
    configBase: configDocumentacao,
    tabelas: coletarTabelas(schemaDocumentacao),
    annotations: coletarAnnotations(schemaDocumentacao),
  },
  {
    nome: "Gerente Agentes (piloto)",
    slug: "gerenteagentes",
    configBase: configGerenteAgentes,
    tabelas: coletarTabelas(schemaGerenteAgentes),
    annotations: coletarAnnotations(schemaGerenteAgentes),
  },
]

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
  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
  const db = drizzle(connection)

  // 1) Projetos — upsert por slug, com a config inicial GERADA.
  for (const semente of PROJETOS_SEED) {
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
    .where(inArray(projetos.slug, PROJETOS_SEED.map((p) => p.slug)))

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
