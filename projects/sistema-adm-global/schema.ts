/**
 * Schema do projeto `sistema-adm-global` — Administrador Global.
 *
 * Tabelas:
 * - Clientes: cadastro de empresas clientes
 * - Contatos do site: mensagens recebidas pelo site
 * - Circulares: comunicados internos
 * - Departamentos: departamentos da empresa
 * - Config empresa: configurações da empresa (singleton)
 * - Responsáveis: responsáveis vinculados a clientes
 * - Contratos: contratos vinculados a clientes
 *
 * Usuários e autenticação são reutilizados do core (PoC §8 — tela Usuários
 * é injetada automaticamente pela plataforma).
 */
import {
  bigint,
  boolean,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"

// ============================================================================
// CLIENTES
// ============================================================================

export const clientes = mysqlTable("clientes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nomeFantasia: varchar("nome_fantasia", { length: 200 }).notNull(),
  razaoSocial: varchar("razao_social", { length: 300 }).notNull(),
  cnpj: varchar("cnpj", { length: 18 }).notNull(),
  inscricaoMunicipal: varchar("inscricao_municipal", { length: 50 }),
  inscricaoEstadual: varchar("inscricao_estadual", { length: 50 }),
  logradouro: varchar("logradouro", { length: 200 }).notNull(),
  numero: varchar("numero", { length: 20 }).notNull(),
  complemento: varchar("complemento", { length: 100 }),
  bairro: varchar("bairro", { length: 100 }).notNull(),
  cidade: varchar("cidade", { length: 100 }).notNull(),
  uf: varchar("uf", { length: 2 }).notNull(),
  cep: varchar("cep", { length: 10 }).notNull(),
  telefone: varchar("telefone", { length: 30 }).notNull(),
  ramal: varchar("ramal", { length: 10 }),
  email: varchar("email", { length: 200 }).notNull(),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// RESPONSÁVEIS (vinculados a clientes)
// ============================================================================

export const responsaveis = mysqlTable("responsaveis", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  clienteId: bigint("cliente_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => clientes.id, { onDelete: "cascade" }),
  nome: varchar("nome", { length: 200 }).notNull(),
  cargo: varchar("cargo", { length: 100 }),
  telefone: varchar("telefone", { length: 30 }),
  email: varchar("email", { length: 200 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// CONTRATOS (vinculados a clientes)
// ============================================================================

export const contratos = mysqlTable("contratos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  clienteId: bigint("cliente_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => clientes.id, { onDelete: "cascade" }),
  numero: varchar("numero", { length: 50 }).notNull(),
  descricao: text("descricao"),
  valor: varchar("valor", { length: 30 }),
  inicio: varchar("inicio", { length: 10 }),
  fim: varchar("fim", { length: 10 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// CONTATOS DO SITE
// ============================================================================

export const contatosSite = mysqlTable("contatos_site", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  email: varchar("email", { length: 200 }).notNull(),
  telefone: varchar("telefone", { length: 30 }),
  assunto: varchar("assunto", { length: 200 }).notNull(),
  mensagem: text("mensagem").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// CIRCULARES
// ============================================================================

export const circulares = mysqlTable("circulares", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  imageUrl: varchar("image_url", { length: 500 }),
  conteudo: text("conteudo").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// DEPARTAMENTOS
// ============================================================================

export const departamentos = mysqlTable("departamentos", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// CONFIG EMPRESA (singleton — um registro apenas)
// ============================================================================

export const configEmpresa = mysqlTable("config_empresa", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  logoUrl: varchar("logo_url", { length: 500 }),
  endereco: varchar("endereco", { length: 300 }),
  cnpj: varchar("cnpj", { length: 18 }),
  telefone: varchar("telefone", { length: 30 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// ANNOTATIONS DE FORMULÁRIO
// ============================================================================

export const annotations = {
  clientes: {
    nomeFantasia: { label: "Nome Fantasia", fullWidth: true, maxLength: 200 },
    razaoSocial: { label: "Razão Social", fullWidth: true, maxLength: 300 },
    cnpj: { label: "CNPJ", maxLength: 18 },
    inscricaoMunicipal: { label: "Inscrição Municipal", maxLength: 50 },
    inscricaoEstadual: { label: "Inscrição Estadual", maxLength: 50 },
    logradouro: { label: "Logradouro", fullWidth: true, maxLength: 200 },
    numero: { label: "Número", maxLength: 20 },
    complemento: { label: "Complemento", maxLength: 100 },
    bairro: { label: "Bairro", maxLength: 100 },
    cidade: { label: "Cidade", maxLength: 100 },
    uf: { label: "UF", maxLength: 2 },
    cep: { label: "CEP", maxLength: 10 },
    telefone: { label: "Telefone", maxLength: 30 },
    ramal: { label: "Ramal", maxLength: 10 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 200 },
    ativo: { label: "Cliente Ativo" },
  },
  contatos_site: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 30 },
    assunto: { label: "Assunto", fullWidth: true, maxLength: 200 },
    mensagem: { label: "Mensagem", type: "textarea", fullWidth: true },
  },
  circulares: {
    titulo: { label: "Título", fullWidth: true, maxLength: 200 },
    imageUrl: { label: "URL da Imagem", fullWidth: true, maxLength: 500 },
    conteudo: { label: "Conteúdo", type: "textarea", fullWidth: true, maxLength: 5000 },
  },
  departamentos: {
    nome: { label: "Nome do Departamento", fullWidth: true, maxLength: 50 },
  },
  config_empresa: {
    nome: { label: "Nome da Empresa", fullWidth: true, maxLength: 200 },
    logoUrl: { label: "URL da Logo", fullWidth: true, maxLength: 500 },
    endereco: { label: "Endereço", fullWidth: true, maxLength: 300 },
    cnpj: { label: "CNPJ", maxLength: 18 },
    telefone: { label: "Telefone", maxLength: 30 },
  },
  responsaveis: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    cargo: { label: "Cargo", maxLength: 100 },
    telefone: { label: "Telefone", maxLength: 30 },
    email: { label: "E-mail", type: "email", fullWidth: true, maxLength: 200 },
  },
  contratos: {
    numero: { label: "Número do Contrato", maxLength: 50 },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    valor: { label: "Valor", maxLength: 30 },
    inicio: { label: "Início", maxLength: 10 },
    fim: { label: "Fim", maxLength: 10 },
    ativo: { label: "Ativo" },
  },
} satisfies FormAnnotationsPorTabela
