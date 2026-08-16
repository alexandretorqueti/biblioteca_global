/**
 * Recria o container da API com as envs atuais + as novas (auth única).
 * Uso: node scripts/recriar-api.js  (após o build da imagem)
 */
const { execSync } = require("node:child_process")
const fs = require("node:fs")

const NOME = "biblioteca-global-api"
const IMAGEM = "biblioteca-global-api:v2"

// Envs atuais do container (preserva segredos sem imprimir).
const inspecao = JSON.parse(
  execSync(`docker inspect ${NOME} --format '{{json .Config.Env}}'`, {
    encoding: "utf8",
  }),
)

// Envs novas a partir do .env local.
const envArquivo = {}
for (const linha of fs.readFileSync(".env", "utf8").split("\n")) {
  const limpa = linha.trim()
  if (!limpa || limpa.startsWith("#")) continue
  const corte = limpa.indexOf("=")
  if (corte < 1) continue
  envArquivo[limpa.slice(0, corte)] = limpa.slice(corte + 1)
}

const extras = [
  "AUTH_CODE_SECRET",
  "AUTH_CODE_TTL_MS",
  "AUTH_MAX_ATTEMPTS",
  "AUTH_RATE_LIMIT_MAX",
  "AUTH_RATE_LIMIT_WINDOW_MS",
  "AUTH_VERIFY_TOKEN_TTL",
  "AUTH_CODE_DEBUG_LOG",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "PROVISION_TOKEN",
]

// Mescla: mantém as atuais, aplica as novas (com default do .env quando existe).
const mapa = new Map()
for (const entrada of inspecao) {
  const corte = entrada.indexOf("=")
  if (corte < 1) continue
  mapa.set(entrada.slice(0, corte), entrada.slice(corte + 1))
}
for (const chave of extras) {
  if (envArquivo[chave] !== undefined) mapa.set(chave, envArquivo[chave])
}
const envs = [...mapa.entries()].map(([k, v]) => `${k}=${v}`)

const args = envs.map((e) => `--env ${JSON.stringify(e)}`).join(" ")

const cmd = [
  "docker rm -f " + NOME,
  "docker run -d --name " + NOME +
    " --network biblioteca-global_default --network-alias api" +
    " --restart unless-stopped" +
    " -p 3003:3001" +
    " " + args +
    " " + IMAGEM,
].join(" && ")

console.log("COMANDO:")
console.log(cmd.replace(/--env "[^"]*PASSWORD[^"]*"/g, '--env "***"').replace(/--env "[^"]*SECRET[^"]*"/g, '--env "***"').replace(/--env "[^"]*TOKEN[^"]*"/g, '--env "***"'))
fs.writeFileSync("/tmp/recriar-api.sh", cmd + "\n")
console.log("\nSalvo em /tmp/recriar-api.sh")
