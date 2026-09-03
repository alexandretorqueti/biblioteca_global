/**
 * Schema do projeto `taqui` — controle de encomendas multi-condomínio.
 *
 * Tabelas:
 * - condominios: síndico cria seu condomínio (vertical/horizontal)
 * - unidades: apartamentos (rua+bloco+andar+apto) ou casas (rua+quadra+lote)
 * - moradores: vinculados a unidades
 * - proprietarios: quando diferentes dos moradores (aluguel)
 * - unidades_proprietarios: vínculo N:N entre unidades e proprietários
 * - funcionarios: triagem/portaria do condomínio
 * - transportadoras: lojas/transportadoras que enviam encomendas
 * - encomendas: registro com foto, loja, unidade; status pendente→confirmada→entregue
 * - notificacoes: sininho para morador
 * - entregas: registro de entrega efetiva com trilha auditável
 *
 * Relações:
 * - condomínio → unidades (1:N)
 * - unidade → moradores (1:N)
 * - unidade ↔ proprietários (N:N via unidades_proprietarios)
 * - condomínio → funcionários (1:N)
 * - encomenda → condomínio, unidade, transportadora, funcionário (registrante), morador (confirmou)
 * - entrega → encomenda, funcionário
 */
import {
  bigint,
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"

// ============================================================================
// CONDOMÍNIOS
// ============================================================================

export const condominios = mysqlTable("condominios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  endereco: varchar("endereco", { length: 500 }).notNull(),
  /** Tipo de estrutura: vertical (apartamentos) ou horizontal (casas). */
  tipo: mysqlEnum("tipo", ["vertical", "horizontal"]).notNull(),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// UNIDADES (apartamentos ou casas)
// ============================================================================

export const unidades = mysqlTable("unidades", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  condominioId: bigint("condominio_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => condominios.id, { onDelete: "cascade" }),
  /** Tipo da unidade: apartamento (vertical) ou casa (horizontal). */
  tipo: mysqlEnum("tipo", ["apartamento", "casa"]).notNull(),
  /** Rua (comum a ambos os tipos). */
  rua: varchar("rua", { length: 200 }),
  /** Bloco (apartamento — opcional). */
  bloco: varchar("bloco", { length: 50 }),
  /** Andar (apartamento — opcional). */
  andar: int("andar"),
  /** Número do apartamento (apartamento). */
  numero: varchar("numero", { length: 20 }),
  /** Quadra (casa — opcional). */
  quadra: varchar("quadra", { length: 50 }),
  /** Lote (casa — opcional). */
  lote: varchar("lote", { length: 50 }),
  /** Label amigável gerado automaticamente (ex.: "Rua A, Bloco 2, Apto 301"). */
  label: varchar("label", { length: 300 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// MORADORES
// ============================================================================

export const moradores = mysqlTable("moradores", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  unidadeId: bigint("unidade_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => unidades.id, { onDelete: "cascade" }),
  nome: varchar("nome", { length: 200 }).notNull(),
  email: varchar("email", { length: 200 }),
  telefone: varchar("telefone", { length: 50 }),
  /** CPF opcional para identificação. */
  cpf: varchar("cpf", { length: 14 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// PROPRIETÁRIOS (quando diferentes dos moradores — aluguel)
// ============================================================================

export const proprietarios = mysqlTable("proprietarios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  email: varchar("email", { length: 200 }),
  telefone: varchar("telefone", { length: 50 }),
  cpf: varchar("cpf", { length: 14 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

/** Vínculo N:N entre unidades e proprietários. */
export const unidadesProprietarios = mysqlTable("unidades_proprietarios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  unidadeId: bigint("unidade_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => unidades.id, { onDelete: "cascade" }),
  proprietarioId: bigint("proprietario_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => proprietarios.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// FUNCIONÁRIOS (triagem / portaria)
// ============================================================================

export const funcionarios = mysqlTable("funcionarios", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  condominioId: bigint("condominio_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => condominios.id, { onDelete: "cascade" }),
  nome: varchar("nome", { length: 200 }).notNull(),
  /** Função do funcionário no condomínio. */
  funcao: mysqlEnum("funcao", ["triagem", "portaria", "ambos"]).notNull(),
  email: varchar("email", { length: 200 }),
  telefone: varchar("telefone", { length: 50 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// TRANSPORTADORAS / LOJAS
// ============================================================================

export const transportadoras = mysqlTable("transportadoras", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  nome: varchar("nome", { length: 200 }).notNull(),
  /** CNPJ opcional. */
  cnpj: varchar("cnpj", { length: 18 }),
  telefone: varchar("telefone", { length: 50 }),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// ENCOMENDAS
// ============================================================================

export const encomendas = mysqlTable("encomendas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  condominioId: bigint("condominio_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => condominios.id, { onDelete: "cascade" }),
  unidadeId: bigint("unidade_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => unidades.id, { onDelete: "cascade" }),
  transportadoraId: bigint("transportadora_id", { mode: "number", unsigned: true })
    .references(() => transportadoras.id, { onDelete: "set null" }),
  /** Funcionário que registrou a encomenda na triagem. */
  registradoPorId: bigint("registrado_por_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => funcionarios.id, { onDelete: "restrict" }),
  /** Código de rastreamento (opcional — pode vir de QR/barcode). */
  codigoRastreamento: varchar("codigo_rastreamento", { length: 100 }),
  /** URL da foto tirada no momento do registro. */
  fotoUrl: varchar("foto_url", { length: 1000 }),
  /** Observações sobre a encomenda (caixa danificada, tamanho, etc.). */
  observacoes: text("observacoes"),
  /**
   * Status do fluxo:
   * - pendente: registrada, aguardando confirmação do morador
   * - confirmada: morador confirmou o recebimento
   * - entregue: triagem liberou a encomenda após confirmação
   * - cancelada: encomenda cancelada (devolução, erro, etc.)
   */
  status: mysqlEnum("status", ["pendente", "confirmada", "entregue", "cancelada"])
    .notNull()
    .default("pendente"),
  /** Morador que confirmou o recebimento. */
  confirmadoPorId: bigint("confirmado_por_id", { mode: "number", unsigned: true })
    .references(() => moradores.id, { onDelete: "set null" }),
  /** Data/hora da confirmação pelo morador. */
  confirmadoEm: timestamp("confirmado_em"),
  /** Funcionário que entregou a encomenda (após confirmação). */
  entreguePorId: bigint("entregue_por_id", { mode: "number", unsigned: true })
    .references(() => funcionarios.id, { onDelete: "set null" }),
  /** Data/hora da entrega efetiva. */
  entregueEm: timestamp("entregue_em"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})

// ============================================================================
// NOTIFICAÇÕES (sininho)
// ============================================================================

export const notificacoes = mysqlTable("notificacoes", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  moradorId: bigint("morador_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => moradores.id, { onDelete: "cascade" }),
  encomendaId: bigint("encomenda_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => encomendas.id, { onDelete: "cascade" }),
  /** Tipo de notificação. */
  tipo: mysqlEnum("tipo", ["encomenda_pendente", "encomenda_confirmada", "encomenda_entregue"]).notNull(),
  /** Mensagem da notificação. */
  mensagem: varchar("mensagem", { length: 500 }).notNull(),
  /** Se já foi lida pelo morador. */
  lida: boolean("lida").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// ============================================================================
// ENTREGAS (registro de entrega efetiva)
// ============================================================================

export const entregas = mysqlTable(
  "entregas",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    encomendaId: bigint("encomenda_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => encomendas.id, { onDelete: "restrict" }),
    funcionarioId: bigint("funcionario_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => funcionarios.id, { onDelete: "restrict" }),
    /** Data/hora da entrega efetiva. */
    dataHoraEntrega: timestamp("data_hora_entrega").notNull().defaultNow(),
    /** Evidência de quem retirou a encomenda (nome, documento, assinatura, etc.). */
    evidenciaQuemRetirou: text("evidencia_quem_retirou"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (table) => [
    index("idx_entregas_encomenda_id").on(table.encomendaId),
    index("idx_entregas_funcionario_id").on(table.funcionarioId),
  ],
)

// ============================================================================
// ANNOTATIONS (metadata de formulário)
// ============================================================================

export const annotations = {
  condominios: {
    nome: { label: "Nome do Condomínio", fullWidth: true, maxLength: 200 },
    endereco: { label: "Endereço", fullWidth: true, maxLength: 500 },
    tipo: { label: "Tipo de Estrutura" },
    ativo: { label: "Ativo" },
  },
  unidades: {
    condominio_id: { label: "Condomínio" },
    tipo: { label: "Tipo de Unidade" },
    rua: { label: "Rua", maxLength: 200 },
    bloco: { label: "Bloco", maxLength: 50, helperText: "Apenas apartamentos" },
    andar: { label: "Andar", helperText: "Apenas apartamentos" },
    numero: { label: "Número", maxLength: 20, helperText: "Número do apartamento" },
    quadra: { label: "Quadra", maxLength: 50, helperText: "Apenas casas" },
    lote: { label: "Lote", maxLength: 50, helperText: "Apenas casas" },
    label: { label: "Identificação", fullWidth: true, helperText: "Gerado automaticamente" },
    ativo: { label: "Ativo" },
  },
  moradores: {
    unidade_id: { label: "Unidade" },
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    email: { label: "E-mail", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 50 },
    cpf: { label: "CPF", maxLength: 14 },
    ativo: { label: "Ativo" },
  },
  proprietarios: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    email: { label: "E-mail", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 50 },
    cpf: { label: "CPF", maxLength: 14 },
    ativo: { label: "Ativo" },
  },
  unidades_proprietarios: {
    unidade_id: { label: "Unidade" },
    proprietario_id: { label: "Proprietário" },
  },
  funcionarios: {
    condominio_id: { label: "Condomínio" },
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    funcao: { label: "Função" },
    email: { label: "E-mail", fullWidth: true, maxLength: 200 },
    telefone: { label: "Telefone", maxLength: 50 },
    ativo: { label: "Ativo" },
  },
  transportadoras: {
    nome: { label: "Nome", fullWidth: true, maxLength: 200 },
    cnpj: { label: "CNPJ", maxLength: 18 },
    telefone: { label: "Telefone", maxLength: 50 },
    ativo: { label: "Ativo" },
  },
  encomendas: {
    condominio_id: { label: "Condomínio" },
    unidade_id: { label: "Unidade" },
    transportadora_id: { label: "Transportadora / Loja" },
    registrado_por_id: { label: "Registrado por" },
    codigo_rastreamento: { label: "Código de Rastreamento", maxLength: 100 },
    foto_url: { label: "Foto", fullWidth: true, maxLength: 1000 },
    observacoes: { label: "Observações", type: "textarea", fullWidth: true },
    status: { label: "Status" },
    confirmado_por_id: { label: "Confirmado por" },
    confirmado_em: { label: "Confirmado em" },
    entregue_por_id: { label: "Entregue por" },
    entregue_em: { label: "Entregue em" },
  },
  notificacoes: {
    morador_id: { label: "Morador" },
    encomenda_id: { label: "Encomenda" },
    tipo: { label: "Tipo" },
    mensagem: { label: "Mensagem", fullWidth: true, maxLength: 500 },
    lida: { label: "Lida" },
  },
  entregas: {
    encomenda_id: { label: "Encomenda" },
    funcionario_id: { label: "Funcionário" },
    data_hora_entrega: { label: "Data/Hora da Entrega" },
    evidencia_quem_retirou: { label: "Evidência de Quem Retirou", type: "textarea", fullWidth: true },
  },
} satisfies FormAnnotationsPorTabela
