/**
 * Subtarefa 1 (auditoria, somente leitura): compara schema.ts do projeto
 * (nomes físicos de colunas) com information_schema real do legado bdportalemp.
 * Não imprime credenciais.
 */
const fs = require("fs")
const { createDecipheriv } = require("crypto")
const mysql = require("mysql2/promise")

const REPO = "/data/workspace/projects/codigofonte/biblioteca-global/.motor-v3-worktrees/task-p6-1001/1365/a1"
const SCHEMA = fs.readFileSync(REPO + "/projects/sistema-adm-global/schema.ts", "utf8")

// Extrai mysqlTable("nome", { prop: tipo("coluna_fisica", ...) }) → mapa tabela→colunas
function extrairTabelas(src) {
  const tabelas = {}
  const re = /mysqlTable\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\n\}\)/g
  let m
  while ((m = re.exec(src))) {
    const [, nome, corpo] = m
    const cols = {}
    const reCol = /(\w+):\s*\w+\(\s*"([^"]+)"/g
    let c
    while ((c = reCol.exec(corpo))) cols[c[2]] = c[1]
    // flags notNull/default
    const linhas = corpo.split("\n")
    const flags = {}
    for (const ln of linhas) {
      const mm = ln.match(/^\s*(\w+):\s*\w+\(\s*"([^"]+)"([\s\S]*)$/)
      if (mm) flags[mm[2]] = { notNull: /\.notNull\(\)/.test(mm[3]), hasDefault: /\.default\(/.test(mm[3]) || /defaultNow\(\)/.test(mm[3]) }
    }
    tabelas[nome] = { cols, flags }
  }
  return tabelas
}

async function main() {
  const tabelasSchema = extrairTabelas(SCHEMA)
  const nomes = Object.keys(tabelasSchema)
  console.log("Tabelas no schema.ts:", nomes.join(", "))

  const env = fs.readFileSync("/data/workspace/projects/codigofonte/biblioteca-global/.env", "utf8")
  const key = env.match(/DB_CREDENTIALS_ENCRYPTION_KEY=(.+?)$/m)[1].trim()
  const keyBuf = /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, "hex") : Buffer.from(key, "base64")
  const core = await mysql.createConnection({ host: "host.docker.internal", port: 3308, user: "root", password: env.match(/MYSQL_ROOT_PASSWORD=(.+?)$/m)[1].trim(), database: "core" })
  const [r] = await core.query("SELECT db_password_criptografado FROM projetos WHERE id = 6241")
  await core.end()
  const [ivB, tagB, ctB] = r[0].db_password_criptografado.split(":").map((p) => Buffer.from(p, "base64"))
  const d = createDecipheriv("aes-256-gcm", keyBuf, ivB)
  d.setAuthTag(tagB)
  const senha = Buffer.concat([d.update(ctB), d.final()]).toString("utf8")

  const l = await mysql.createConnection({ host: "bdportalemp.mysql.dbaas.com.br", port: 3306, user: "bdportalemp", password: senha, connectTimeout: 15000 })

  for (const t of nomes) {
    const [rows] = await l.query(
      "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'bdportalemp' AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [t],
    )
    console.log("\n==== " + t + " ====")
    if (!rows.length) { console.log("  !! TABELA NÃO EXISTE NO LEGADO"); continue }
    const legadoCols = new Map(rows.map((x) => [x.COLUMN_NAME, x]))
    const schemaCols = Object.keys(tabelasSchema[t].cols)
    // colunas no schema faltando no legado
    const faltando = schemaCols.filter((c) => !legadoCols.has(c))
    // colunas no legado não declaradas no schema (extras — permitidas, mas documentar)
    const extras = rows.map((x) => x.COLUMN_NAME).filter((c) => !schemaCols.includes(c))
    console.log("  colunas schema.ts:", schemaCols.length, "| legado:", rows.length)
    if (faltando.length) console.log("  ❌ NO SCHEMA, AUSENTE NO LEGADO:", faltando.join(", "))
    if (extras.length) console.log("  ⚠️ EXTRAS NO LEGADO (fora do schema):", extras.join(", "))
    // divergências de nulabilidade/tipo por coluna comum
    for (const c of schemaCols) {
      const leg = legadoCols.get(c)
      if (!leg) continue
      const flags = tabelasSchema[t].flags[c] || {}
      const legNull = leg.IS_NULLABLE === "YES"
      const issues = []
      if (!flags.notNull && legNull === false && leg.EXTRA !== "auto_increment") issues.push("schema=nullable, legado=NOT NULL (def=" + leg.COLUMN_DEFAULT + ")")
      if (flags.notNull && legNull === true) issues.push("schema=NOT NULL, legado=NULLABLE")
      // type check grosseiro
      const st = SCHEMA.slice(SCHEMA.indexOf('mysqlTable("' + t + '"') >= 0 ? 0 : 0) // noop
      if (issues.length) console.log("   • " + c + ": " + issues.join(" | ") + "  [" + leg.COLUMN_TYPE + "]")
    }
    // tipos completos para diff manual
    const linhasTipos = rows.map((x) => "  " + x.COLUMN_NAME + " " + x.COLUMN_TYPE + " null=" + x.IS_NULLABLE + " def=" + JSON.stringify(x.COLUMN_DEFAULT) + (x.EXTRA ? " [" + x.EXTRA + "]" : "")).join("\n")
    console.log(linhasTipos)
  }

  // FKs relevantes
  console.log("\n==== FKs (KEY_COLUMN_USAGE com REFERENCED) ====")
  const [fk] = await l.query("SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='bdportalemp' AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME IN (" + nomes.map(() => "?").join(",") + ")", nomes)
  fk.forEach((x) => console.log("  " + x.TABLE_NAME + "." + x.COLUMN_NAME + " -> " + x.REFERENCED_TABLE_NAME + "." + x.REFERENCED_COLUMN_NAME + " (" + x.CONSTRAINT_NAME + ")"))
  const semFk = nomes.filter((t) => !fk.some((f) => f.TABLE_NAME === t))
  console.log("  tabelas SEM FK no legado:", semFk.join(", ") || "(nenhuma)")

  await l.end()
}
main().catch((e) => { console.error("ERR", e.code || e.message); process.exit(1) })
