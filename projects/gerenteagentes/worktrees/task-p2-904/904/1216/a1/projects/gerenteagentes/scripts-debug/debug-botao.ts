/**
 * debug-botao.ts — réplica READ-ONLY, linha a linha, do caminho do botão
 * "Iniciar desenvolvimento" (GerenteAgentesService.iniciarDesenvolvimento
 * + dispararMissaoSetup). Nada é inserido/atualizado: o script mostra o que
 * cada etapa lê e o que SERIA gravado (DRY-RUN).
 *
 * Rodar: node --inspect-brk --import tsx --enable-source-maps scripts-debug/debug-botao.ts
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { eq } from "drizzle-orm"
import { projetosCaptados, contatos, tarefas } from "../schema"

const aqui = path.dirname(fileURLToPath(import.meta.url))

function lerEnv() {
  const raiz = path.resolve(aqui, "..", "..", "..")
  const env: Record<string, string> = {}
  for (const linha of readFileSync(path.join(raiz, ".env"), "utf8").split("\n")) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(linha)) {
      const i = linha.indexOf("=")
      env[linha.slice(0, i)] = linha.slice(i + 1)
    }
  }
  return env
}

const env = lerEnv()
const PROJETO_ID = 6
const EMAIL_LOGADO = "alexandre.globaltecnologia@gmail.com" // usuário core id 1

function titulo(n: number, s: string) {
  console.log(`\n===== PASSO ${n} — ${s} =====`)
}

async function main() {
  debugger
  titulo(1, "conectar no banco runtime (projeto_640)")
  const conn = await mysql.createConnection({
    host: "172.20.0.3",
    port: 3306,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: "projeto_640",
  })
  const db = drizzle(conn)
  console.log("conectado:", conn.threadId)

  debugger
  titulo(2, "SELECT projetos_captados id=6 (drizzle, colunas do schema)")
  const [projeto] = await db
    .select()
    .from(projetosCaptados)
    .where(eq(projetosCaptados.id, PROJETO_ID))
    .limit(1)
  if (!projeto) throw new Error("Projeto não encontrado")
  console.log({
    id: projeto.id,
    nome: projeto.nome,
    slug: projeto.slug,
    contatoId: projeto.contatoId,
    plataformaProjetoId: projeto.plataformaProjetoId,
    repoPath: (projeto as any).repoPath ?? null,
    descricaoLen: projeto.descricao?.length ?? 0,
  })

  debugger
  titulo(3, "resolver email do cliente (contato → fallback logado)")
  let emailCliente = EMAIL_LOGADO
  let nomeCliente: string | undefined
  if (projeto.contatoId) {
    const [contato] = await db
      .select()
      .from(contatos)
      .where(eq(contatos.id, projeto.contatoId))
      .limit(1)
    if (contato?.email) {
      emailCliente = contato.email
      nomeCliente = contato.nome ?? undefined
    }
    console.log("contato do projeto:", contato ? { id: contato.id, email: contato.email } : null)
  } else {
    console.log("sem contatoId → fallback para email do usuário logado")
  }
  console.log({ emailCliente, nomeCliente: nomeCliente ?? null })

  debugger
  titulo(4, "idempotência: já provisionado?")
  if (projeto.plataformaProjetoId) {
    console.log("JÁ provisionado — botão retornaria 'já provisionado'")
  } else {
    console.log("não provisionado — seguiria para o provisionamento")
  }

  debugger
  titulo(5, "SELECT projeto executor (slug biblioteca-global)")
  const [executor] = await db
    .select()
    .from(projetosCaptados)
    .where(eq(projetosCaptados.slug, "biblioteca-global"))
    .limit(1)
  if (!executor) throw new Error("Projeto executor biblioteca-global não encontrado")
  console.log({ id: executor.id, nome: executor.nome, slug: executor.slug })

  debugger
  titulo(6, "idempotência: tarefa setup-<slug> já existe?")
  const motorId = `setup-${projeto.slug}`
  const [existente] = await db
    .select({ id: tarefas.id, status: tarefas.status })
    .from(tarefas)
    .where(eq(tarefas.externalId, motorId))
    .limit(1)
  console.log({ motorId, existente: existente ?? null })

  debugger
  titulo(7, "resolução do agente executor pelo motor (JOIN agentes)")
  const [agentes] = await conn.query(
    `SELECT COALESCE(a.openclaw_agent_id, a.nome) AS agent_id, a.nome
       FROM projetos_captados pc
       LEFT JOIN agentes a ON a.id = pc.agente_id
      WHERE pc.id = ?`,
    [executor.id],
  )
  console.log("agente que executaria a missão:", agentes)

  debugger
  titulo(8, "checagens no core (read-only)")
  const core = await mysql.createConnection({
    host: "172.20.0.3",
    port: 3306,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: "core",
  })
  const [usu] = await core.query(
    "SELECT id, nome, email FROM usuarios WHERE email = ? LIMIT 1",
    [emailCliente],
  )
  console.log("usuário no core para o email do cliente:", usu)
  const [projCore] = await core.query(
    "SELECT id, nome, slug FROM projetos WHERE slug = ? LIMIT 1",
    [projeto.slug],
  )
  console.log("já existe projeto no core com esse slug?", projCore)
  await core.end()

  debugger
  titulo(9, "DRY-RUN: o que SERIA gravado")
  console.log(JSON.stringify({
    provision: {
      nomeProjeto: projeto.nome,
      slug: projeto.slug,
      emailUsuario: emailCliente,
      nomeUsuario: nomeCliente ?? projeto.nome,
      extraAdminUserIds: [Number(env.PLATAFORMA_OWNER_USER_ID ?? "1")],
      descricao: `descricao (${projeto.descricao?.length ?? 0} chars)`,
    },
    tarefa: {
      externalId: motorId,
      projetoId: executor.id,
      titulo: `Setup do projeto: ${projeto.nome}`,
      status: "planned",
      depois: "POST /api/motor/task/<id>/enqueue",
    },
  }, null, 2))

  await conn.end()
  console.log("\n===== FIM — nenhuma escrita foi feita =====")
}

main().catch((err) => {
  console.error("ERRO NO DEBUG:", err)
  process.exit(1)
})
