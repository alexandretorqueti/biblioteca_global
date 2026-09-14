// @vitest-environment node
/**
 * Regressão: `DELETE /api/projetos/:id` é soft delete (PoC §6.2 — o database do
 * projeto é preservado). O `listar` do repositório precisa filtrar
 * `ativo = true`; sem isso o projeto desativado continuava aparecendo na tela
 * e o botão "Excluir" parecia não funcionar.
 *
 * Teste funcional (usa o MySQL do ambiente; skipa sem MYSQL_HOST) porque a
 * garantia é a query SQL, não a orquestração do serviço. Tudo roda dentro de
 * uma transação que sempre faz rollback: nenhum registro de teste fica no
 * banco compartilhado (o seed funcional de provisionamento conta as linhas de
 * `projetos` e não pode ver lixo de teste).
 */
import { describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { eq } from "drizzle-orm"
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2"
import * as schema from "../../../../../../database/schema"
import { loadEnv } from "../../../../../../database/env"
import {
  DrizzleProjetosRepository,
  type ProjetosRepository,
} from "../projetos.repository"

const hasMysql = Boolean(process.env.MYSQL_HOST)

/** Sinal interno para forçar o rollback da transação de teste. */
class RollbackDaTransacao extends Error {}

async function emTransacao<T>(
  fn: (dbTx: MySql2Database<typeof schema>) => Promise<T>,
): Promise<T> {
  const env = loadEnv()
  const pool = mysql.createPool({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectionLimit: 1,
  })
  const db = drizzle(pool, { schema, mode: "default" })
  let resultado!: T
  try {
    await db.transaction(async tx => {
      const dbTx = tx as unknown as MySql2Database<typeof schema>
      resultado = await fn(dbTx)
      throw new RollbackDaTransacao()
    })
  } catch (erro) {
    if (!(erro instanceof RollbackDaTransacao)) throw erro
  } finally {
    await pool.end()
  }
  return resultado
}

/** Cria o projeto com o slug informado dentro da transação. */
async function criarProjetoDeTeste(
  dbTx: MySql2Database<typeof schema>,
  slug: string,
  ativo: boolean,
): Promise<number> {
  await dbTx.insert(schema.projetos).values({
    nome: `ZZ Teste ${slug}`,
    slug,
    ativo,
    config: { app: { name: "ZZ Teste" }, groups: [] },
  })
  const linhas = await dbTx
    .select({ id: schema.projetos.id })
    .from(schema.projetos)
    .where(eq(schema.projetos.slug, slug))
    .limit(1)
  const linha = linhas.at(0)
  if (!linha) {
    throw new Error(`projeto de teste ${slug} não foi criado`)
  }
  return linha.id
}

describe.skipIf(!hasMysql)(
  "DrizzleProjetosRepository.listar — somente ativos",
  () => {
    it("devolve o projeto ativo e omite o desativado", async () => {
      const resultado = await emTransacao(async dbTx => {
        const repo: ProjetosRepository = new DrizzleProjetosRepository(dbTx)
        const slugAtivo = `zz-teste-listar-ativos-a-${Date.now()}`
        const slugInativo = `zz-teste-listar-ativos-b-${Date.now()}`
        await criarProjetoDeTeste(dbTx, slugAtivo, true)
        await criarProjetoDeTeste(dbTx, slugInativo, false)
        return { lista: await repo.listar({ page: 1, pageSize: 100 }), slugAtivo, slugInativo }
      })

      const slugs = resultado.lista.items.map(item => item.slug)
      expect(slugs).toContain(resultado.slugAtivo)
      expect(slugs).not.toContain(resultado.slugInativo)
    })

    it("reproduz o fluxo do botão Excluir: ao desativar, o projeto sai da lista", async () => {
      const resultado = await emTransacao(async dbTx => {
        const repo: ProjetosRepository = new DrizzleProjetosRepository(dbTx)
        const slug = `zz-teste-listar-ativos-c-${Date.now()}`
        const id = await criarProjetoDeTeste(dbTx, slug, true)

        const antes = await repo.listar({ page: 1, pageSize: 100 })
        await repo.atualizar(id, { ativo: false })
        const depois = await repo.listar({ page: 1, pageSize: 100 })

        return { antes, depois, slug }
      })

      expect(resultado.antes.items.map(item => item.slug)).toContain(
        resultado.slug,
      )
      expect(resultado.depois.items.map(item => item.slug)).not.toContain(
        resultado.slug,
      )
      expect(resultado.depois.total).toBe(resultado.antes.total - 1)
    })
  },
)
