// O script é executado pelo runtime Node/tsx da plataforma; os tipos de
// mysql2 e Node não fazem parte do pacote de schema deste projeto.
// @ts-nocheck
/**
 * Importação única e transacional do legado.
 *
 * A conexão de origem é criada em modo READ ONLY e só é usada para montar um
 * snapshot antes de qualquer escrita no destino. O destino só recebe o lote
 * depois que o snapshot foi validado.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise"

const execFileAsync = promisify(execFile)

type SourceClient = RowDataPacket & {
  id: number; nome_fantasia: string | null; razao_social: string | null; cnpj: string | null
  inscricao_municipal: string | null; inscricao_estadual: string | null; logradouro: string | null
  numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null
  uf: string | null; cep: string | null; telefone: string | null; ramal: string | null
  email: string | null; ativo: number | null; data: Date | null; data_edicao: Date | null
}
type SourceResponsible = RowDataPacket & { id: number; cliente_id: number | null; nome: string | null; telefone: string | null; email: string | null }
type SourceContract = RowDataPacket & { id: number; cliente_id: number | null; numerocontrato: string | null; data: Date | null }
type SourceCircular = RowDataPacket & { Id: number; Titulo: string; Conteudo: string; DataPublicacao: Date | null; LinkImagem: string | null; Ativo: number | null }
type SourceContact = RowDataPacket & { nome: string; email: string; telefone: string | null; assunto: string | null; mensagem: string | null; data_envio: Date | null }
type SourceCompany = RowDataPacket & { nome: string | null; logo_url: string | null; endereco: string | null; cnpj: string | null; telefone: string | null }

type QueryConnection = Pick<Pool, "query"> & Partial<Pick<Pool, "getConnection">>

export type ImportResult = {
  clientes: number; responsaveis: number; contratos: number; circulares: number
  contatos: number; departamentos: number; configEmpresa: number
}

const text = (value: unknown, fallback = "") => String(value ?? fallback).trim()
const nullable = (value: unknown) => {
  const result = text(value)
  return result === "" ? null : result
}
const dateOrNull = (value: unknown) => value instanceof Date && !Number.isNaN(value.valueOf()) ? value : null

function validClient(row: SourceClient) {
  return [row.nome_fantasia, row.razao_social, row.cnpj, row.logradouro, row.numero,
    row.bairro, row.cidade, row.uf, row.cep, row.telefone, row.email].every(value => text(value) !== "")
}

async function rows<T extends RowDataPacket>(connection: QueryConnection, sql: string): Promise<T[]> {
  const [result] = await connection.query(sql)
  return result as T[]
}

/** Faz o backup do destino sem executar qualquer comando na origem. */
export async function backupDestination(options: {
  output: string
  host: string; port: number; user: string; password: string; database: string
}) {
  await execFileAsync("mysqldump", [
    "--single-transaction", "--routines", "--events", "--triggers",
    "--host", options.host, "--port", String(options.port), "--user", options.user,
    `--password=${options.password}`, options.database, "--result-file", options.output,
  ])
}

/** Executa o lote já validado; a conexão de origem nunca é usada para escrita. */
export async function importProductionData(source: QueryConnection, destination: PoolConnection): Promise<ImportResult> {
  // A origem é sempre consultada antes de abrir a transação do destino.
  const [clients, responsaveis, contracts, circulars, contacts, departments, companies] = await Promise.all([
    rows<SourceClient>(source, "SELECT id,nome_fantasia,razao_social,cnpj,inscricao_municipal,inscricao_estadual,logradouro,numero,complemento,bairro,cidade,uf,cep,telefone,ramal,email,ativo,data,data_edicao FROM clientes ORDER BY id"),
    rows<SourceResponsible>(source, "SELECT id,cliente_id,nome,telefone,email FROM responsaveis ORDER BY id"),
    rows<SourceContract>(source, "SELECT id,cliente_id,numerocontrato,data FROM contratos ORDER BY id"),
    rows<SourceCircular>(source, "SELECT Id,Titulo,Conteudo,DataPublicacao,LinkImagem,Ativo FROM circular WHERE Ativo = 1 ORDER BY Id"),
    rows<SourceContact>(source, "SELECT nome,email,telefone,assunto,mensagem,data_envio FROM api_contatosite_contatos ORDER BY id"),
    rows<RowDataPacket & { nome: string }>(source, "SELECT nome FROM departamentos ORDER BY id"),
    rows<SourceCompany>(source, "SELECT nome,logo_url,endereco,cnpj,telefone FROM config_empresa ORDER BY id LIMIT 1"),
  ])
  const validClients = clients.filter(validClient)
  const clientIds = new Set(validClients.map(row => row.id))
  const validResponsaveis = responsaveis.filter(row => clientIds.has(Number(row.cliente_id)) && text(row.nome) !== "")
  const validContracts = contracts.filter(row => clientIds.has(Number(row.cliente_id)) && text(row.numerocontrato) !== "")
  const validDepartments = departments.filter(row => text(row.nome) !== "")
  const validCirculars = circulars.filter(row => text(row.Titulo) !== "" && text(row.Conteudo) !== "")
  const validContacts = contacts.filter(row => text(row.nome) !== "" && text(row.email) !== "" && text(row.assunto) !== "" && text(row.mensagem) !== "")

  await destination.beginTransaction()
  try {
    const idMap = new Map<number, number>()
    for (const row of validClients) {
      const [result] = await destination.query(
        "INSERT INTO clientes (nome_fantasia,razao_social,cnpj,inscricao_municipal,inscricao_estadual,logradouro,numero,complemento,bairro,cidade,uf,cep,telefone,ramal,instagram,email,ativo,administrador_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,COALESCE(?,CURRENT_TIMESTAMP),COALESCE(?,CURRENT_TIMESTAMP))",
        [row.nome_fantasia, row.razao_social, row.cnpj, nullable(row.inscricao_municipal), nullable(row.inscricao_estadual), row.logradouro, row.numero, nullable(row.complemento), row.bairro, row.cidade, row.uf, row.cep, row.telefone, nullable(row.ramal), null, row.email, row.ativo !== 0, dateOrNull(row.data), dateOrNull(row.data_edicao)],
      )
      idMap.set(row.id, Number((result as { insertId: number }).insertId))
    }
    for (const row of validResponsaveis) {
      await destination.query("INSERT INTO responsaveis (cliente_id,nome,cargo,telefone,email) VALUES (?,?,NULL,?,?)", [idMap.get(Number(row.cliente_id)), row.nome, nullable(row.telefone), nullable(row.email)])
    }
    for (const row of validContracts) {
      await destination.query("INSERT INTO contratos (cliente_id,numero,descricao,valor,inicio,fim,ativo) VALUES (?,?,NULL,NULL,NULL,NULL,1)", [idMap.get(Number(row.cliente_id)), row.numerocontrato])
    }
    for (const row of validContacts) {
      await destination.query("INSERT INTO contatos_site (nome,email,telefone,assunto,mensagem,data_envio) VALUES (?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))", [row.nome, row.email, nullable(row.telefone), row.assunto, row.mensagem, dateOrNull(row.data_envio)])
    }
    for (const row of validCirculars) {
      await destination.query("INSERT INTO circulares (titulo,image_url,conteudo,publicado_em) VALUES (?,?,?,COALESCE(?,CURRENT_TIMESTAMP))", [row.Titulo, nullable(row.LinkImagem), row.Conteudo, dateOrNull(row.DataPublicacao)])
    }
    for (const row of validDepartments) {
      await destination.query("INSERT INTO departamentos (nome) VALUES (?)", [row.nome])
    }
    let configEmpresa = 0
    if (companies[0] && text(companies[0].nome)) {
      const [existing] = await destination.query("SELECT id FROM config_empresa LIMIT 1")
      if ((existing as RowDataPacket[]).length === 0) {
        const company = companies[0]
        await destination.query("INSERT INTO config_empresa (nome,logo_url,endereco,cnpj,telefone) VALUES (?,?,?,?,?)", [company.nome, nullable(company.logo_url), nullable(company.endereco), nullable(company.cnpj), nullable(company.telefone)])
        configEmpresa = 1
      }
    }
    await destination.commit()
    return { clientes: validClients.length, responsaveis: validResponsaveis.length, contratos: validContracts.length, circulares: validCirculars.length, contatos: validContacts.length, departamentos: validDepartments.length, configEmpresa }
  } catch (error) {
    await destination.rollback()
    throw error
  }
}

async function main() {
  const env = process.env
  const source = await mysql.createConnection({ host: env.LEGACY_DB_HOST, database: env.LEGACY_DB_NAME, user: env.LEGACY_DB_USER, password: env.LEGACY_DB_PASSWORD })
  // Proibição do servidor para qualquer DML/DDL nesta conexão.
  await source.query("SET SESSION TRANSACTION READ ONLY")
  const destination = await mysql.createPool({ host: env.DESTINATION_DB_HOST ?? "127.0.0.1", port: Number(env.DESTINATION_DB_PORT ?? 3308), database: env.DESTINATION_DB_NAME ?? "projeto_6241", user: env.DESTINATION_DB_USER, password: env.DESTINATION_DB_PASSWORD })
  try {
    await backupDestination({ output: env.DESTINATION_BACKUP_FILE ?? `./backup-projeto-6241-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`, host: env.DESTINATION_DB_HOST ?? "127.0.0.1", port: Number(env.DESTINATION_DB_PORT ?? 3308), user: env.DESTINATION_DB_USER!, password: env.DESTINATION_DB_PASSWORD!, database: env.DESTINATION_DB_NAME ?? "projeto_6241" })
    const connection = await destination.getConnection()
    try {
      console.log(JSON.stringify(await importProductionData(source, connection)))
    } finally {
      connection.release()
    }
  } finally { await source.end(); await destination.end() }
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1 })
