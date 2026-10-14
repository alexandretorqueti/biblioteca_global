// READ-ONLY evidência de rotas autenticadas. Não imprime credenciais nem tokens.
const mysql = require("mysql2/promise")
const crypto = require("crypto")
const fs = require("fs")
const env = fs.readFileSync("/data/workspace/projects/codigofonte/biblioteca-global/.env", "utf8")
const secret = env.match(/^JWT_SECRET=(.+)$/m)[1].trim()
const root = env.match(/MYSQL_ROOT_PASSWORD=(.+)$/m)[1].trim()

function signJWT(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const head = b64({ alg: "HS256", typ: "JWT" })
  const body = b64({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 })
  const sig = crypto.createHmac("sha256", secret).update(head + "." + body).digest("base64url")
  return head + "." + body + "." + sig
}

async function getToken() {
  const c = await mysql.createConnection({ host: "host.docker.internal", port: 3308, user: "root", password: root, database: "core" })
  const [v] = await c.query("SELECT u.id, pu.perfil FROM usuarios u JOIN projetos_usuarios pu ON pu.usuario_id = u.id WHERE pu.projeto_id = 6241 AND u.ativo = 1 AND pu.perfil = 'admin' LIMIT 1")
  await c.end()
  return signJWT({ sub: v[0].id, projetoId: 6241, perfil: v[0].perfil })
}

const ROTAS = [
  ["DASHBOARD-ROTA", "/sistema-adm-global/circulares?pageSize=1"],
  ["circular", "/sistema-adm-global/circular?pageSize=3"],
  ["clientes", "/sistema-adm-global/clientes?pageSize=1"],
  ["api_contatosite_contatos", "/sistema-adm-global/api_contatosite_contatos?pageSize=1"],
  ["responsaveis", "/sistema-adm-global/responsaveis?pageSize=1"],
  ["contratos", "/sistema-adm-global/contratos?pageSize=1"],
  ["departamentos", "/sistema-adm-global/departamentos?pageSize=2"],
  ["cargos", "/sistema-adm-global/cargos?pageSize=1"],
  ["colaboradores", "/sistema-adm-global/colaboradores?pageSize=1"],
  ["config_empresa", "/sistema-adm-global/config_empresa?pageSize=1"],
  ["usuarios-via-slug", "/sistema-adm-global/usuarios?pageSize=1"],
  ["usuarios-dedicado", "/usuarios?pageSize=1"],
]

async function attempt() {
  const token = await getToken()
  const out = []
  let ok = 0
  for (const [label, r] of ROTAS) {
    try {
      const res = await fetch("http://host.docker.internal:3003/api" + r, { headers: { authorization: "***" + token } })
      const txt = await res.text()
      out.push("### " + label + " GET /api" + r + " -> HTTP " + res.status)
      out.push(txt.slice(0, 420).replace(/"senha":"[^"]*"/g, '"senha":"***"').replace(/"passwordHash":"[^"]*"/g, '"passwordHash":"***"'))
      if (res.status !== 0) ok++
    } catch (e) {
      out.push("### " + label + " -> DOWN (" + (e.cause?.code || e.message) + ")")
    }
  }
  return { down: out.some((l) => l.includes("DOWN")), text: out.join("\n") }
}

async function main() {
  for (let i = 0; i < 40; i++) {
    const { down, text } = await attempt()
    if (!down) {
      console.log("API UP — evidência completa:\n")
      console.log(text)
      return
    }
    await new Promise((res) => setTimeout(res, 5000))
  }
  console.log("API permaneceu indisponível durante ~3min; última tentativa:\n" + (await attempt()).text)
}
main().catch((e) => { console.error("ERR", e.code || e.message); process.exit(1) })
