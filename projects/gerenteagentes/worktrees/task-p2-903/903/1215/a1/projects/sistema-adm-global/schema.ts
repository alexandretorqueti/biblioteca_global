/**
 * Schema do projeto `sistema-adm-global` — Administrador Global.
 *
 * Espelha a estrutura do banco legado `bdportalemp` (MySQL DbaaS).
 *
 * Tabelas:
 * - Clientes: cadastro de empresas clientes
 * - Responsáveis: responsáveis vinculados a clientes
 * - Contratos: contratos vinculados a clientes
 * - Contatos do site: mensagens recebidas pelo site (api_contatosite_contatos)
 * - Circulares: comunicados internos (circular)
 * - Departamentos: departamentos da empresa
 * - Cargos: cargos/funções da empresa
 * - Colaboradores: cadastro de colaboradores da empresa
 * - Usuários: admin/usuario do projeto (escopo local)
 * - Config empresa: configurações da empresa (singleton)
 *
 * Database: bdportalemp (legado via ProjectDbFactory).
 */
import {
  bigint,
  boolean,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"

// ============================================================================
// USUÁRIOS (escopo do projeto — admin/usuario)
// ============================================================================

export const usuarios = mysqlTable("usuarios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 100 }),
  email: varchar("email", { length: 150 }).notNull(),
  senha: varchar("senha", { length: 255 }),
  papel: varchar("papel", { length: 50 }),
  ativo: boolean("ativo").default(true),
  primeiro_acesso: boolean("primeiro_acesso").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
})

// ============================================================================
// CLIENTES
// ============================================================================

export const clientes = mysqlTable("clientes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nomeFantasia: varchar("nome_fantasia", { length: 100 }),
  razaoSocial: varchar("razao_social", { length: 100 }),
  cnpj: varchar("cnpj", { length: 20 }),
  inscricaoMunicipal: varchar("inscricao_municipal", { length: 50 }),
  inscricaoEstadual: varchar("inscricao_estadual", { length: 50 }),
  logradouro: varchar("logradouro", { length: 100 }),
  numero: varchar("numero", { length: 10 }),
  complemento: varchar("complemento", { length: 50 }),
  bairro: varchar("bairro", { length: 50 }),
  cidade: varchar("cidade", { length: 50 }),
  uf: varchar("uf", { length: 2 }),
  cep: varchar("cep", { length: 10 }),
  telefone: varchar("telefone", { length: 20 }),
  ramal: varchar("ramal", { length: 10 }),
  instagram: varchar("instagram", { length: 200 }),
  email: varchar("email", { length: 100 }),
  ativo: boolean("ativo").default(true),
  usuario: varchar("usuario", { length: 50 }),
  data: timestamp("data").defaultNow(),
  data_edicao: timestamp("data_edicao").defaultNow(),
})

// ============================================================================
// RESPONSÁVEIS (vinculados a clientes)
// ============================================================================

export const responsaveis = mysqlTable("responsaveis", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  clienteId: bigint("cliente_id", { mode: "number", unsigned: true }),
  nome: varchar("nome", { length: 100 }),
  cargo: varchar("cargo", { length: 100 }),
  cpf: varchar("cpf", { length: 14 }),
  logradouro: varchar("logradouro", { length: 100 }),
  numero: varchar("numero", { length: 10 }),
  complemento: varchar("complemento", { length: 50 }),
  bairro: varchar("bairro", { length: 50 }),
  cidade: varchar("cidade", { length: 50 }),
  uf: varchar("uf", { length: 2 }),
  cep: varchar("cep", { length: 10 }),
  telefone: varchar("telefone", { length: 20 }),
  ramal: varchar("ramal", { length: 10 }),
  email: varchar("email", { length: 100 }),
  data: timestamp("data").defaultNow(),
})

// ============================================================================
// CONTRATOS (vinculados a clientes)
// ============================================================================

export const contratos = mysqlTable("contratos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  clienteId: bigint("cliente_id", { mode: "number", unsigned: true }),
  numerocontrato: varchar("numerocontrato", { length: 50 }),
  linkcontrato: varchar("linkcontrato", { length: 255 }),
  descricao: text("descricao"),
  valor: varchar("valor", { length: 30 }),
  inicio: varchar("inicio", { length: 10 }),
  fim: varchar("fim", { length: 10 }),
  ativo: boolean("ativo").default(true),
  data: timestamp("data").defaultNow(),
})

// ============================================================================
// CONTATOS DO SITE (api_contatosite_contatos)
// ============================================================================

export const contatosSite = mysqlTable("api_contatosite_contatos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  siteId: bigint("site_id", { mode: "number", unsigned: true }).notNull(),
  nome: varchar("nome", { length: 100 }).notNull(),
  email: varchar("email", { length: 150 }).notNull(),
  telefone: varchar("telefone", { length: 20 }),
  assunto: varchar("assunto", { length: 150 }).notNull().default(""),
  mensagem: text("mensagem").notNull(),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 500 }),
  origem: varchar("origem", { length: 200 }),
  dataEnvio: timestamp("data_envio").defaultNow(),
})

// ============================================================================
// CIRCULARES (circular)
// ============================================================================

export const circulares = mysqlTable("circular", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  conteudo: text("conteudo").notNull(),
  autor: varchar("autor", { length: 100 }),
  publicadoEm: timestamp("publicado_em"),
  imageUrl: varchar("image_url", { length: 500 }),
  ativo: boolean("ativo").default(true),
})

// ============================================================================
// DEPARTAMENTOS
// ============================================================================

export const departamentos = mysqlTable("departamentos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
})

// ============================================================================
// CARGOS
// ============================================================================

export const cargos = mysqlTable("cargos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
})

// ============================================================================
// COLABORADORES
// ============================================================================

export const colaboradores = mysqlTable("colaboradores", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nomeCompleto: varchar("nome_completo", { length: 200 }).notNull(),
  cpf: varchar("cpf", { length: 14 }).notNull(),
  rg: varchar("rg", { length: 20 }),
  email: varchar("email", { length: 200 }).notNull(),
  telefone: varchar("telefone", { length: 30 }).notNull(),
  dataNascimento: varchar("data_nascimento", { length: 10 }).notNull(),
  cargoId: bigint("cargo_id", { mode: "number", unsigned: true }).notNull(),
  departamentoId: bigint("departamento_id", { mode: "number", unsigned: true }),
  dataAdmissao: varchar("data_admissao", { length: 10 }).notNull(),
  tipoVinculo: mysqlEnum("tipo_vinculo", ["clt", "pj", "estagio", "temporario", "apprentiz"]).notNull().default("clt"),
  logradouro: varchar("logradouro", { length: 200 }),
  numero: varchar("numero", { length: 20 }),
  complemento: varchar("complemento", { length: 100 }),
  bairro: varchar("bairro", { length: 100 }),
  cidade: varchar("cidade", { length: 100 }),
  uf: varchar("uf", { length: 2 }),
  cep: varchar("cep", { length: 10 }),
  contatoEmergenciaNome: varchar("contato_emergencia_nome", { length: 200 }),
  contatoEmergenciaTelefone: varchar("contato_emergencia_telefone", { length: 30 }),
  ativo: boolean("ativo").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
})

// ============================================================================
// CONFIG EMPRESA (singleton — um registro apenas)
// ============================================================================

export const configEmpresa = mysqlTable("config_empresa", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 100 }),
  logoUrl: varchar("logo_url", { length: 255 }),
  endereco: varchar("endereco", { length: 255 }),
  cnpj: varchar("cnpj", { length: 18 }),
  telefone: varchar("telefone", { length: 20 }),
})

// ============================================================================
// ANNOTATIONS DE FORMULÁRIO
// ============================================================================

export const annotations = {
  clientes: {
    nomeFantasia: { label: "Nome Fantasia", fullWidth: true, maxLength: 100 },
    razaoSocial: { label: "Razão Social", fullWidth: true, maxLength: 100 },
    cnpj: { label: "CNPJ", maxLength: 20 },
    inscricaoMunicipal: { label: "Inscrição Municipal", maxLength: 50 },
    inscricaoEstadual: { label: "Inscrição Estadual", maxLength: 50 },
    logradouro: { label: "Logradouro", fullWidth: true, maxLength: 100 },
    numero: { label: "Número", maxLength: 10 },
    complemento: { label: "Complemento", maxLength: 50 },
    bairro: { label: "Bairro", maxLength: 50 },
    cidade: { label: "Cidade", maxLength: 50 },
    uf: { label: "UF", maxLength: 2 },
    cep: { label: "CEP", maxLength: 10 },
    telefone: { label: "Telefone", maxLength: 20 },
    ramal: { label: "Ramal", maxLength: 10 },
    instagram: { label: "Instagram", maxLength: 200 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 100 },
    ativo: { label: "Cliente Ativo" },
    usuario: { label: "Usuário" },
    data: { label: "Data de Cadastro" },
    data_edicao: { label: "Data de Edição" },
  },
  api_contatosite_contatos: {
    siteId: { label: "Site ID" },
    nome: { label: "Nome", fullWidth: true, maxLength: 100 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 150 },
    telefone: { label: "Telefone", maxLength: 20 },
    assunto: { label: "Assunto", fullWidth: true, maxLength: 150 },
    mensagem: { label: "Mensagem", type: "textarea", fullWidth: true },
    ip: { label: "IP" },
    userAgent: { label: "User Agent" },
    origem: { label: "Origem" },
    dataEnvio: { label: "Data de Entrada" },
  },
  circular: {
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    conteudo: { label: "Conteúdo", type: "textarea", fullWidth: true },
    autor: { label: "Autor", maxLength: 100 },
    publicadoEm: { label: "Publicado Em" },
    imageUrl: { label: "URL da Imagem", fullWidth: true, maxLength: 500 },
    ativo: { label: "Ativo" },
  },
  departamentos: {
    nome: { label: "Nome do Departamento", fullWidth: true, maxLength: 100 },
  },
  cargos: {
    nome: { label: "Nome do Cargo", fullWidth: true, maxLength: 100 },
  },
  colaboradores: {
    nomeCompleto: { label: "Nome Completo", fullWidth: true, maxLength: 200 },
    cpf: { label: "CPF", maxLength: 14 },
    rg: { label: "RG", maxLength: 20 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 30 },
    dataNascimento: { label: "Data de Nascimento", maxLength: 10 },
    cargoId: { label: "Cargo" },
    departamentoId: { label: "Departamento" },
    dataAdmissao: { label: "Data de Admissão", maxLength: 10 },
    tipoVinculo: { label: "Tipo de Vínculo" },
    logradouro: { label: "Logradouro", fullWidth: true, maxLength: 200 },
    numero: { label: "Número", maxLength: 20 },
    complemento: { label: "Complemento", maxLength: 100 },
    bairro: { label: "Bairro", maxLength: 100 },
    cidade: { label: "Cidade", maxLength: 100 },
    uf: { label: "UF", maxLength: 2 },
    cep: { label: "CEP", maxLength: 10 },
    contatoEmergenciaNome: { label: "Contato de Emergência (Nome)", fullWidth: true, maxLength: 200 },
    contatoEmergenciaTelefone: { label: "Contato de Emergência (Telefone)", maxLength: 30 },
    ativo: { label: "Ativo" },
  },
  config_empresa: {
    nome: { label: "Nome da Empresa", fullWidth: true, maxLength: 100 },
    logoUrl: { label: "URL da Logo", fullWidth: true, maxLength: 255 },
    endereco: { label: "Endereço", fullWidth: true, maxLength: 255 },
    cnpj: { label: "CNPJ", maxLength: 18 },
    telefone: { label: "Telefone", maxLength: 20 },
  },
  responsaveis: {
    nome: { label: "Nome", fullWidth: true, maxLength: 100 },
    cargo: { label: "Cargo", maxLength: 100 },
    cpf: { label: "CPF", maxLength: 14 },
    logradouro: { label: "Logradouro", fullWidth: true, maxLength: 100 },
    numero: { label: "Número", maxLength: 10 },
    complemento: { label: "Complemento", maxLength: 50 },
    bairro: { label: "Bairro", maxLength: 50 },
    cidade: { label: "Cidade", maxLength: 50 },
    uf: { label: "UF", maxLength: 2 },
    cep: { label: "CEP", maxLength: 10 },
    telefone: { label: "Telefone", maxLength: 20 },
    ramal: { label: "Ramal", maxLength: 10 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 100 },
  },
  contratos: {
    numerocontrato: { label: "Número do Contrato", maxLength: 50 },
    linkcontrato: { label: "Link do Contrato", fullWidth: true, maxLength: 255 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    valor: { label: "Valor", maxLength: 30 },
    inicio: { label: "Início", maxLength: 10 },
    fim: { label: "Fim", maxLength: 10 },
    ativo: { label: "Ativo" },
  },
  usuarios: {
    nome: { label: "Nome", fullWidth: true, maxLength: 100 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 150 },
    senha: { label: "Senha", maxLength: 255 },
    papel: { label: "Perfil", maxLength: 50 },
    ativo: { label: "Ativo" },
    primeiro_acesso: { label: "Primeiro Acesso" },
  },
} satisfies FormAnnotationsPorTabela
