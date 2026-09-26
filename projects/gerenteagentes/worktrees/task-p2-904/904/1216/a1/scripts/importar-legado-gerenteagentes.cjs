/**
 * IMPORTAÇÃO ÚNICA (one-shot) — 19/08: consolida o banco legado
 * `projeto_gerenteagentes` (cópia do motor via script PG→MySQL) no banco
 * oficial do projeto `projeto_640`.
 *
 * Constatado em 19/08: o 640 JÁ continha uma cópia prévia dos dados do
 * motor (com re-ID). Esta importação:
 *   - preserva os IDs do 640 (o motor e os chats existentes os referenciam);
 *   - usa UPSERT (INSERT ... ON DUPLICATE KEY UPDATE) — estado do legado
 *     (mais recente) vence em conflito;
 *   - remapeia as PKs do legado → IDs do 640 por correspondência explícita
 *     (mapas por conteúdo, ver MAPAS_ABAIXO);
 *   - FKs seguem o re-mapeamento;
 *   - linhas cujas FKs não têm correspondência: descartadas;
 *   - `__drizzle_migrations` nunca é tocada.
 *
 * One-shot: os mapas dependem do estado de 19/08. Após concluir, o legado
 * é descartado (DROP DATABASE projeto_gerenteagentes).
 *
 * Uso: `node scripts/importar-legado-gerenteagentes.cjs`
 * (lê scripts/.env; overrides via env vars MYSQL_*_OVERRIDE).
 */
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")

const ENV_PATH = path.join(__dirname, ".env")

function carregarEnv() {
  const texto = fs.readFileSync(ENV_PATH, "utf8")
  const get = (k) => {
    const m = texto.match(new RegExp("^" + k + "=(.*)$", "m"))
    return m ? m[1].trim() : undefined
  }
  return {
    host: process.env.MYSQL_HOST_OVERRIDE || get("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT_OVERRIDE || get("MYSQL_PORT") || 3308),
    user: process.env.MYSQL_USER_OVERRIDE || get("MYSQL_USER") || "root",
    password:
      process.env.MYSQL_PASSWORD_OVERRIDE !== undefined
        ? process.env.MYSQL_PASSWORD_OVERRIDE
        : (get("MYSQL_PASSWORD") || ""),
  }
}

const ORIGEM = "projeto_gerenteagentes"
const DESTINO = "projeto_640"

/**
 * Correspondências id legado → id no 640 (verificadas por conteúdo em 19/08).
 *
 * - agentes / projetos_captados: IDs idênticos (importação prévia do motor
 *   preservou as PKs).
 * - contatos: o 640 tem os 18 em DUPLICADO (ids 40–57 e 58–65); mapeia
 *   para o bloco 40–57 (o mais antigo). As 18 linhas novas criadas pelo
 *   motor (58–65) permanecem como duplicatas pré-existentes do 640
 *   (não são deste script).
 * - tarefas: 10 correspondem por título; as 5 órfãs (4, 11–14) não têm
 *   equivalente — seus filhos são descartados.
 * - chats: IDs idênticos (1, 2 já existem no 640 com os mesmos dados).
 */
const MAPAS_ID = {
  agentes: { 1: 1, 2: 2 },
  projetos_captados: { 1: 1, 2: 2 },
  contatos: { 1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55, 8: 56, 9: 57, 10: 42, 11: 43, 12: 44, 13: 45, 14: 46, 15: 47, 16: 48, 17: 17, 18: 18 },
  tarefas: { 1: 1, 2: 1, 3: 16, 5: 17, 6: 18, 7: 25, 8: 26, 9: 27, 10: 28, 15: 15 },
  chats: { 1: 1, 2: 2 },
}

// Ordem por dependência (FKs): pai antes do filho.
const TABELAS = [
  "agentes",
  "projetos_captados",
  "contatos",
  "tarefas",
  "subtarefas",
  "chats",
  "chat_mensagens",
  "tarefa_chats",
  "projeto_chats",
  "definicoes",
  "bloqueios",
  "geracoes_projeto",
]

async function fksDaTabela(conn, db, tabela) {
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME " +
      "FROM information_schema.KEY_COLUMN_USAGE " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
    [db, tabela],
  )
  return rows
}

async function main() {
  const env = carregarEnv()
  const conn = await mysql.createConnection(env)
  const idMap = {} // tabela -> Map(idLegado -> idDestino)
  let total = 0
  try {
    // Mapas fixos primeiro (pais com correspondência conhecida)
    for (const [tabela, mapa] of Object.entries(MAPAS_ID)) {
      idMap[tabela] = new Map(Object.entries(mapa).map(([k, v]) => [Number(k), v]))
    }

    for (const tabela of TABELAS) {
      const fks = await fksDaTabela(conn, ORIGEM, tabela)
      const [cols] = await conn.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        [ORIGEM, tabela],
      )
      const nomes = cols.map((c) => c.COLUMN_NAME)
      const temId = nomes.includes("id")
      const [linhas] = await conn.query(
        "SELECT * FROM `" + ORIGEM + "`.`" + tabela + "`"
      )
      if (!linhas.length) {
        console.log("  (vazia)      " + tabela)
        continue
      }

      // 1) Filtrar órfãs: FK sem correspondência no mapa do pai
      const validas = []
      let descartadas = 0
      for (const l of linhas) {
        let ok = true
        for (const fk of fks) {
          const v = l[fk.COLUMN_NAME]
          if (v === null || v === undefined) continue
          const paiMap = idMap[fk.REFERENCED_TABLE_NAME]
          if (!paiMap || !paiMap.has(v)) {
            ok = false
            break
          }
        }
        if (ok) validas.push(l)
        else descartadas++
      }

      // 2) IDs de destino
      //    - com mapa fixo: usa o mapa (preserva ID do 640)
      //    - sem mapa: PKs do destino que já existiam com o MESMO id do
      //      legado são mantidas; as demais recebem novo ID (máx+1).
      const mapa = idMap[tabela] || new Map()
      let novoIdStart = 0
      if (temId && !MAPAS_ID[tabela]) {
        novoIdStart = (
          await (async () => {
            const [r] = await conn.query(
              "SELECT COALESCE(MAX(`id`), 0) AS m FROM `" + DESTINO + "`.`" + tabela + "`"
            )
            return Number(r[0].m)
          })()
        ) + 1
        // IDs do destino que colidem com PKs do legado → manter o do legado
        const [r] = await conn.query(
          "SELECT `id` FROM `" + DESTINO + "`.`" + tabela + "`"
        )
        for (const l of linhas) {
          if (l.id === null || l.id === undefined) continue
          if (r.some((x) => x.id === l.id)) mapa.set(l.id, l.id)
        }
      }
      if (temId) idMap[tabela] = mapa

      if (!validas.length) {
        console.log("  (nada: órfãs " + descartadas + ") " + tabela)
        continue
      }

      // 3) UPSERT
      const list = nomes.map((n) => "`" + n + "`").join(", ")
      const placeholders = nomes.map(() => "?").join(", ")
      const updCols = nomes.filter((n) => n !== "id")
      const sql =
        "INSERT INTO `" + DESTINO + "`.`" + tabela + "` (" + list + ") VALUES (" + placeholders + ") " +
        "ON DUPLICATE KEY UPDATE " + updCols.map((n) => n + " = VALUES(" + n + ")").join(", ")

      const LOTE = 100
      for (let i = 0; i < validas.length; i += LOTE) {
        const lote = validas.slice(i, i + LOTE)
        const params = lote.flatMap((l) =>
          nomes.map((n) => {
            if (n === "id" && l.id !== null && l.id !== undefined) {
              if (!mapa.has(l.id)) {
                const novo = novoIdStart++
                mapa.set(l.id, novo)
              }
              return mapa.get(l.id)
            }
            for (const fk of fks) {
              if (n === fk.COLUMN_NAME && l[n] !== null && l[n] !== undefined) {
                return idMap[fk.REFERENCED_TABLE_NAME].get(l[n])
              }
            }
            return l[n]
          })
        )
        await conn.execute(sql, params)
      }
      total += validas.length
      const idsDestino = validas.map((l) => mapa.get(l.id)).filter((v) => v !== undefined)
      console.log(
        "  +" + String(validas.length).padStart(3) +
        (descartadas ? " (órfãs: " + descartadas + ")" : "") +
        "  " + tabela +
        (idsDestino.length ? "  [ids destino: " + Math.min(...idsDestino) + "–" + Math.max(...idsDestino) + "]" : "")
      )
    }
    console.log("Concluído: " + total + " linhas upsertadas para " + DESTINO + ".")
  } finally {
    await conn.end()
  }
}

main().catch((e) => {
  console.error("FALHA:", e.message)
  process.exit(1)
})
