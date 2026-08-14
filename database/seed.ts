/**
 * Seed idempotente do database core (PoC §4.3 / §9).
 * - Projetos `biblioteca-global` e `documentacao` (upsert por slug).
 * - Usuário `alexandre` (upsert por username; senha inicial NUNCA é
 *   sobrescrita — se ele já trocou, o re-seed preserva a nova).
 * - Vínculos admin nos dois projetos (upsert pela PK composta).
 */
import argon2 from "argon2"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
import {
  geradorSistemaConfigSchema,
  type GeradorSistemaConfig,
} from "@biblioteca-global/shared"
import { loadEnv } from "./env.js"
import { projetos, projetosUsuarios, usuarios } from "./schema.js"

/** POC §9.3 — senha descartável; Alexandre troca no primeiro login. */
const SENHA_INICIAL_DESCARTAVEL = "Bo4MfU29r0GPi1"

interface ProjetoSeed {
  nome: string
  slug: string
  config: GeradorSistemaConfig
}

/** POC §9.1 — projeto dono da plataforma (admin global). */
const CONFIG_BIBLIOTECA_GLOBAL: GeradorSistemaConfig = {
  app: { name: "Biblioteca Global", logo: "menu_book" },
  groups: [
    {
      id: "administracao",
      label: "Administração",
      items: [
        {
          id: "usuarios",
          label: "Usuários",
          path: "usuarios",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "usuarios",
            title: "Usuários",
            description: "Gerenciamento global de usuários e vínculos",
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columns: 2,
              newLabel: "Novo usuário",
            },
          },
        },
        {
          id: "projetos",
          label: "Projetos",
          path: "projetos",
          icon: "folder",
          screen: {
            kind: "cadastro",
            resource: "projetos",
            title: "Projetos",
            description: "CRUD de projetos com editor de config validado",
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo projeto",
            },
          },
        },
      ],
    },
  ],
}

/** POC §9.2 — documentação viva como telas custom (registry no front). */
const CONFIG_DOCUMENTACAO: GeradorSistemaConfig = {
  app: { name: "Documentação", logo: "menu_book" },
  groups: [
    {
      id: "documentacao",
      label: "Documentação",
      items: [
        {
          id: "documentacao",
          label: "Biblioteca de Componentes",
          path: "documentacao",
          icon: "menu_book",
          screen: { kind: "custom", componentId: "documentation" },
        },
      ],
    },
  ],
}

const PROJETOS_SEED: ProjetoSeed[] = [
  {
    nome: "Biblioteca Global",
    slug: "biblioteca-global",
    config: CONFIG_BIBLIOTECA_GLOBAL,
  },
  { nome: "Documentação", slug: "documentacao", config: CONFIG_DOCUMENTACAO },
]

async function main(): Promise<void> {
  const env = loadEnv()
  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  })
  const db = drizzle(connection)

  // 1) Projetos — upsert por slug; re-aplica a config inicial canônica.
  for (const semente of PROJETOS_SEED) {
    const config = geradorSistemaConfigSchema.parse(semente.config)
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
      email: "alexandre@globaltecnologia.com.br",
      nome: "Alexandre",
      passwordHash,
      ativo: true,
    })
    .onDuplicateKeyUpdate({
      set: {
        nome: "Alexandre",
        email: "alexandre@globaltecnologia.com.br",
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

  // 4) Resumo.
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

main().catch((erro: unknown) => {
  console.error("Seed falhou:", erro)
  process.exitCode = 1
})
