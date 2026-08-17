// @vitest-environment node
/**
 * Testes funcionais — provisionamento dos projetos iniciais (critérios de
 * saída da Etapa 6): databases projeto_<id> criados, migrations aplicadas,
 * config gerada salva no core e idempotência do seed.
 */
import { beforeAll, describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import {
  coletarAnnotations,
  coletarTabelas,
  montarConfigInicial,
} from "@biblioteca-global/schema-tools"
import { geradorSistemaConfigSchema } from "@biblioteca-global/shared"
import { loadEnv } from "../../../../../../database/env"
import { seed } from "../../../../../../database/seed"
import { config as configBibliotecaGlobal } from "../../../../../../projects/biblioteca-global/config"
import * as schemaBibliotecaGlobal from "../../../../../../projects/biblioteca-global/schema"
import { config as configDocumentacao } from "../../../../../../projects/documentacao/config"
import * as schemaDocumentacao from "../../../../../../projects/documentacao/schema"

describe("provisionamento dos projetos iniciais (Etapa 6)", () => {
  let documentacaoId: number
  let bibliotecaGlobalId: number
  let conexaoApp: mysql.Connection

  beforeAll(async () => {
    await seed()

    const env = loadEnv()
    conexaoApp = await mysql.createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    })
    const [linhas] = await conexaoApp.query(
      "SELECT id, slug FROM projetos WHERE slug IN ('documentacao', 'biblioteca-global')",
    )
    const lista = linhas as Array<{ id: number; slug: string }>
    const doc = lista.find((l) => l.slug === "documentacao")
    const bg = lista.find((l) => l.slug === "biblioteca-global")
    if (!doc || !bg) {
      throw new Error("projetos do seed ausentes")
    }
    documentacaoId = doc.id
    bibliotecaGlobalId = bg.id
  }, 120_000)

  async function databases(): Promise<string[]> {
    const [linhas] = await conexaoApp.query("SHOW DATABASES")
    return (linhas as Array<{ Database: string }>).map((l) => l.Database)
  }

  async function tabelasDe(database: string): Promise<string[]> {
    const env = loadEnv()
    const conexao = await mysql.createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database,
    })
    try {
      const [linhas] = await conexao.query("SHOW TABLES")
      return (linhas as Array<Record<string, string>>).map(
        (linha) => Object.values(linha).at(0) ?? "",
      )
    } finally {
      await conexao.end()
    }
  }

  it("seed é idempotente (roda de novo sem duplicar)", async () => {
    await seed()
    // alexandre é o único usuário criado pelo seed; demais podem ser resíduo de outros testes.
    const [linhasAlex] = await conexaoApp.query(
      "SELECT COUNT(*) AS n FROM usuarios WHERE username = ?",
      ["alexandre"],
    )
    const alexContagem = (linhasAlex as Array<{ n: number }>).at(0)?.n ?? -1
    expect(alexContagem).toBe(1)
    // Projetos e vínculos são exclusivos do seed.
    const contagem = async (tabela: string): Promise<number> => {
      const [linhas] = await conexaoApp.query("SELECT COUNT(*) AS n FROM " + tabela)
      const primeira = (linhas as Array<{ n: number }>).at(0)
      return Number(primeira?.n ?? -1)
    }
    expect(await contagem("projetos")).toBe(3)
    expect(await contagem("projetos_usuarios")).toBe(3)
  }, 120_000)

  it("SHOW DATABASES lista core e projeto_<id> dos projetos do seed", async () => {
    const nomes = await databases()
    expect(nomes).toContain("core")
    expect(nomes).toContain(`projeto_${bibliotecaGlobalId}`)
    expect(nomes).toContain(`projeto_${documentacaoId}`)
  })

  it("tabelas de negócio presentes apenas no database do projeto", async () => {
    const tabelasDoc = await tabelasDe(`projeto_${documentacaoId}`)
    expect(tabelasDoc).toContain("componentes")
    expect(tabelasDoc).toContain("__drizzle_migrations")

    const tabelasBg = await tabelasDe(`projeto_${bibliotecaGlobalId}`)
    expect(tabelasBg).not.toContain("componentes")
  })

  it("config do biblioteca-global no core = base versionada (sem tabelas de negócio)", async () => {
    const [linhas] = await conexaoApp.query(
      "SELECT config FROM projetos WHERE slug = 'biblioteca-global'",
    )
    const salva = (linhas as Array<{ config: unknown }>).at(0)?.config
    if (!salva) throw new Error("config ausente no core")
    expect(salva).toEqual(configBibliotecaGlobal)
  })

  it("config do documentacao no core = base + telas geradas do schema", async () => {
    const esperada = geradorSistemaConfigSchema.parse(
      montarConfigInicial(
        configDocumentacao,
        coletarTabelas(schemaDocumentacao),
        coletarAnnotations(schemaDocumentacao),
      ),
    )
    const [linhas] = await conexaoApp.query(
      "SELECT config FROM projetos WHERE slug = 'documentacao'",
    )
    const salva = (linhas as Array<{ config: unknown }>).at(0)?.config
    if (!salva) throw new Error("config ausente no core")
    expect(salva).toEqual(esperada)

    // A tela gerada carrega os fields com as annotations do schema.
    const config = salva as typeof esperada
    const cadastros = config.groups.find((g) => g.id === "cadastros")
    const tela = cadastros?.items.find((i) => i.id === "componentes")
    expect(tela?.screen.kind).toBe("cadastro")
    if (tela?.screen.kind === "cadastro") {
      const nome = tela.screen.fields?.find((f) => f.name === "nome")
      expect(nome).toMatchObject({
        label: "Nome",
        fullWidth: true,
        required: true,
      })
    }
  })

  it("config gerada para schema vazio permanece a base", () => {
    const config = montarConfigInicial(
      configBibliotecaGlobal,
      coletarTabelas(schemaBibliotecaGlobal),
      coletarAnnotations(schemaBibliotecaGlobal),
    )
    expect(config).toEqual(configBibliotecaGlobal)
  })
})
