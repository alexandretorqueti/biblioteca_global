/**
 * Seed idempotente dos 4 índices de mercado do projeto
 * `calculadora-de-investimentos-gabriel` (plano macro #6, posição 1/9 —
 * REQ-F-001/REQ-D-003).
 *
 * Índices: CDI, Selic, IPCA, Ibovespa — `ordem` 1–4, exatamente como exige
 * o critério de aceite. As taxas são valores iniciais plausíveis e são
 * sobrescritas pela cotação automática (SGS/BrasilAPI), que pertence a
 * subtarefa própria deste plano.
 *
 * Idempotência: INSERT ... ON DUPLICATE KEY UPDATE pela unique
 * `indices_sigla_unica` — rodar N vezes mantém exatamente 1 linha por sigla
 * e atualiza nome/taxa/fonte/ordem. Nunca duplica.
 *
 * Uso (a partir da raiz do repositório):
 *   npx tsx projects/calculadora-de-investimentos-gabriel/seed-indices.ts
 *
 * Conexão: MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD do ambiente
 * (com .env da raiz como fallback via dotenv) e database
 * CALCULADORA_GABRIEL_DATABASE ?? projeto_8499 — mesmo padrão do
 * drizzle.config.ts deste projeto e dos scripts do gerenteagentes.
 * Nunca senha embutida no arquivo.
 */
import { resolve } from "node:path"
import { config as carregarEnv } from "dotenv"
import mysql from "mysql2/promise"

carregarEnv({ path: resolve(process.cwd(), ".env"), quiet: true })

const database = process.env.CALCULADORA_GABRIEL_DATABASE ?? "projeto_8499"

interface IndiceSeed {
  nome: string
  sigla: string
  /** % a.a. com 4 casas (decimal(9,4)); a mensal é derivada, nunca semeada. */
  taxaAnual: string
  fonteCotacao: string
  ordem: number
}

/** Os 4 índices do ESPECIFICACAO.md (RF-3), ordem estável 1–4. */
const INDICES_SEED: readonly IndiceSeed[] = [
  { nome: "CDI", sigla: "CDI", taxaAnual: "15.0000", fonteCotacao: "Banco Central (SGS)", ordem: 1 },
  { nome: "Selic", sigla: "SELIC", taxaAnual: "15.0000", fonteCotacao: "Banco Central (SGS)", ordem: 2 },
  { nome: "IPCA", sigla: "IPCA", taxaAnual: "4.5000", fonteCotacao: "Banco Central (SGS)", ordem: 3 },
  { nome: "Ibovespa", sigla: "IBOV", taxaAnual: "12.0000", fonteCotacao: "Banco Central (SGS)", ordem: 4 },
]

/**
 * O pacote é CJS ("type": "commonjs"), e o tsx/esbuild não suporta
 * top-level await nesse formato — todo o fluxo assíncrono fica em main(),
 * como em projects/gerenteagentes/src/scripts/prompt-defaults.ts.
 */
async function main(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3308),
    user: process.env.MYSQL_USER ?? "biblioteca",
    password: process.env.MYSQL_PASSWORD ?? process.env.MYSQL_ROOT_PASSWORD ?? "",
    database,
  })

  try {
    const [tabelas] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = 'indices'",
      [database],
    )
    if (tabelas.length === 0) {
      throw new Error(
        `Tabela 'indices' ausente em ${database} — aplique as migrations do projeto antes do seed ` +
          "(drizzle-kit migrate --config projects/calculadora-de-investimentos-gabriel/drizzle.config.ts).",
      )
    }

    for (const indice of INDICES_SEED) {
      await connection.query(
        `INSERT INTO indices (nome, sigla, taxa_anual, fonte_cotacao, ordem)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           nome = VALUES(nome),
           taxa_anual = VALUES(taxa_anual),
           fonte_cotacao = VALUES(fonte_cotacao),
           ordem = VALUES(ordem)`,
        [indice.nome, indice.sigla, indice.taxaAnual, indice.fonteCotacao, indice.ordem],
      )
    }

    const [linhas] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT nome, sigla, taxa_anual, fonte_cotacao, ordem FROM indices ORDER BY ordem",
    )
    console.log(
      `Seed de índices aplicado em ${database}: ${linhas.length} linha(s) ` +
        `[${linhas.map((l) => `${l.ordem}:${l.nome}`).join(", ")}]`,
    )
  } finally {
    await connection.end()
  }
}

main().catch((error: unknown) => {
  console.error("Seed de índices falhou:", error)
  process.exitCode = 1
})
