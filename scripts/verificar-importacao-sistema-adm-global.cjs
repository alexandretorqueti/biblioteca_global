#!/usr/bin/env node
/*
 * Verificador somente-leitura da carga do legado do Administrador Global.
 *
 * Todas as consultas são SELECT contra information_schema ou SELECT * nas
 * bases informadas. Este arquivo deliberadamente não contém INSERT, UPDATE,
 * DELETE, DDL, transação de escrita ou alteração de sessão.
 *
 * Uso (segredos somente por ambiente):
 *   ORIGEM_MYSQL_PASSWORD='...' DESTINO_MYSQL_PASSWORD='...' \
 *   node scripts/verificar-importacao-sistema-adm-global.cjs
 */
const mysql = require("mysql2/promise")

const TABELAS_DESTINO = new Set([
  "clientes", "responsaveis", "contratos", "circulares",
  "departamentos", "config_empresa",
])

const MAPA_ORIGEM = {
  clientes: "clientes",
  responsaveis: "responsaveis",
  contratos: "contratos",
  circular: "circulares",
  circulares: "circulares",
  departamentos: "departamentos",
  config_empresa: "config_empresa",
}

const CONTRATO = {
  clientes: {
    required: ["nome_fantasia", "razao_social", "cnpj", "logradouro", "numero", "bairro", "cidade", "uf", "cep", "telefone", "email"],
    max: { nome_fantasia: 200, razao_social: 300, cnpj: 18, inscricao_municipal: 50, inscricao_estadual: 50, logradouro: 200, numero: 20, complemento: 100, bairro: 100, cidade: 100, uf: 2, cep: 10, telefone: 30, ramal: 10, instagram: 200, email: 200 },
  },
  responsaveis: { required: ["cliente_id", "nome"], max: { nome: 200, cargo: 100, telefone: 30, email: 200 } },
  contratos: { required: ["cliente_id", "numero"], max: { numero: 50, valor: 30, inicio: 10, fim: 10 } },
  circulares: { required: ["titulo", "conteudo"], max: { titulo: 200, image_url: 500, conteudo: 5000 } },
  departamentos: { required: ["nome"], max: { nome: 50 } },
  config_empresa: { required: ["nome"], max: { nome: 200, logo_url: 500, endereco: 300, cnpj: 18, telefone: 30 } },
}

function env(nome, padrao) {
  return process.env[nome] ?? padrao
}

function conexao(prefixo, padroes) {
  const password = process.env[`${prefixo}_MYSQL_PASSWORD`]
  if (password === undefined) throw new Error(`Variável obrigatória ausente: ${prefixo}_MYSQL_PASSWORD`)
  return mysql.createConnection({
    host: env(`${prefixo}_MYSQL_HOST`, padroes.host),
    port: Number(env(`${prefixo}_MYSQL_PORT`, padroes.port)),
    user: env(`${prefixo}_MYSQL_USER`, padroes.user),
    password,
    database: env(`${prefixo}_MYSQL_DATABASE`, padroes.database),
  })
}

function identificador(valor) {
  return String(valor).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function valorColuna(linha, nome) {
  const alvo = identificador(nome)
  const chave = Object.keys(linha).find((k) => identificador(k) === alvo)
  return chave === undefined ? undefined : linha[chave]
}

function textoVazio(valor) {
  return valor === null || valor === undefined || String(valor).trim() === ""
}

function dataValida(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return true
  if (valor instanceof Date) return !Number.isNaN(valor.getTime())
  const texto = String(valor).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto)
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto)
  if (!iso && !br) return false
  const ano = Number(iso ? iso[1] : br[3])
  const mes = Number(iso ? iso[2] : br[2]) - 1
  const dia = Number(iso ? iso[3] : br[1])
  const d = new Date(Date.UTC(ano, mes, dia))
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes && d.getUTCDate() === dia
}

function statusValido(valor) {
  return valor === null || valor === undefined || [true, false, 0, 1, "0", "1", "true", "false", "TRUE", "FALSE", "Ativo", "ativo", "Inativo", "inativo"].includes(valor)
}

function motivosLinha(linha, destino) {
  const contrato = CONTRATO[destino]
  const motivos = []
  for (const campo of contrato.required) {
    if (textoVazio(valorColuna(linha, campo))) motivos.push(`obrigatório ausente: ${campo}`)
  }
  for (const [campo, limite] of Object.entries(contrato.max)) {
    const valor = valorColuna(linha, campo)
    if (valor !== null && valor !== undefined && String(valor).length > limite) motivos.push(`limite excedido: ${campo} (${String(valor).length}>${limite})`)
  }
  if (destino === "clientes") {
    const uf = valorColuna(linha, "uf")
    if (!textoVazio(uf) && String(uf).trim().length !== 2) motivos.push("UF deve ter 2 caracteres")
    const email = valorColuna(linha, "email")
    if (!textoVazio(email) && !/^\S+@\S+\.\S+$/.test(String(email).trim())) motivos.push("e-mail inválido")
  }
  if (["clientes", "contratos", "circulares"].includes(destino) && !statusValido(valorColuna(linha, "ativo"))) motivos.push("status ativo inválido")
  if (destino === "contratos") {
    for (const campo of ["inicio", "fim"]) if (!dataValida(valorColuna(linha, campo))) motivos.push(`data inválida: ${campo}`)
  }
  if (destino === "circulares" && !dataValida(valorColuna(linha, "publicado_em"))) motivos.push("data inválida: publicado_em")
  return motivos
}

async function tabelas(conn, database) {
  const [rows] = await conn.execute(
    "SELECT TABLE_NAME AS nome FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [database],
  )
  return rows.map((row) => row.nome)
}

async function linhas(conn, database, tabela) {
  // O nome vem exclusivamente de information_schema; ainda assim só aceitamos
  // identificadores conhecidos para impedir SQL arbitrário.
  if (!/^[a-zA-Z0-9_]+$/.test(tabela)) throw new Error(`Identificador inválido: ${tabela}`)
  const [rows] = await conn.query(`SELECT * FROM \`${database}\`.\`${tabela}\``)
  return rows
}

async function verificar() {
  const origemDb = env("ORIGEM_MYSQL_DATABASE", "bdportalemp")
  const destinoDb = env("DESTINO_MYSQL_DATABASE", "projeto_6241")
  for (const database of [origemDb, destinoDb]) if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error(`Nome de banco inválido: ${database}`)
  const origem = await conexao("ORIGEM", { host: "bdportalemp.mysql.dbaas.com.br", port: 3306, user: "bdportalemp", database: origemDb })
  const destino = await conexao("DESTINO", { host: "localhost", port: 3308, user: "root", database: destinoDb })
  try {
    const [origemTabelas, destinoTabelas] = await Promise.all([tabelas(origem, origemDb), tabelas(destino, destinoDb)])
    const relatorio = { contrato: { origem: origemDb, destino: destinoDb, somenteLeitura: true }, tabelas: { incluidas: [], excluidas: [] }, lotes: {}, administradorId: { sempreNulo: true, ignorados: 0 }, erros: [] }
    for (const tabela of origemTabelas) {
      const destinoTabela = MAPA_ORIGEM[tabela.toLowerCase()]
      let motivo = "sem tabela destino no contrato"
      if (/^api_/i.test(tabela)) motivo = "prefixo api_* excluído"
      else if (/^w/i.test(tabela)) motivo = "prefixo w* excluído"
      else if (tabela.toLowerCase() === "usuarios") motivo = "usuarios excluída; não alterar FK local"
      else if (destinoTabela && !TABELAS_DESTINO.has(destinoTabela)) motivo = "destino não permitido"
      else if (destinoTabela && !destinoTabelas.includes(destinoTabela)) motivo = `tabela destino ausente: ${destinoTabela}`
      if (!destinoTabela || !destinoTabelas.includes(destinoTabela)) {
        relatorio.tabelas.excluidas.push({ origem: tabela, motivo })
      } else {
        relatorio.tabelas.incluidas.push({ origem: tabela, destino: destinoTabela })
      }
    }
    const elegiveisClientes = new Set()
    for (const item of relatorio.tabelas.incluidas) {
      const origemLinhas = await linhas(origem, origemDb, item.origem)
      const destino = item.destino
      const registros = []
      let elegiveis = 0
      for (const linha of origemLinhas) {
        const motivos = motivosLinha(linha, destino)
        const id = valorColuna(linha, "id")
        if (destino === "clientes" && motivos.length === 0) elegiveisClientes.add(String(id))
        if ((destino === "responsaveis" || destino === "contratos") && !elegiveisClientes.has(String(valorColuna(linha, "cliente_id")))) motivos.push("cliente-pai não elegível")
        if (destino === "circulares" && ![true, 1, "1", "true", "TRUE", "Ativo", "ativo"].includes(valorColuna(linha, "ativo"))) motivos.push("não está Ativo")
        if (destino === "clientes" && valorColuna(linha, "administrador_id") != null) relatorio.administradorId.ignorados++
        if (motivos.length === 0) elegiveis++
        else registros.push({ id: id ?? null, motivos })
      }
      relatorio.lotes[destino] = { origem: item.origem, total: origemLinhas.length, elegiveis, naoImportaveis: registros }
    }
    return relatorio
  } finally {
    await Promise.all([origem.end(), destino.end()])
  }
}

if (require.main === module) verificar().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(`FALHA: ${e.message}`); process.exitCode = 1 })
module.exports = { CONTRATO, MAPA_ORIGEM, dataValida, motivosLinha, verificar }
