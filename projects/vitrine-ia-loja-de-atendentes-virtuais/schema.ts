/**
 * Schema do projeto `vitrine-ia-loja-de-atendentes-virtuais` — Vitrine IA,
 * loja de atendentes virtuais.
 *
 * Fonte única do modelo de dados (PoC §6/§7): este arquivo gera as migrations
 * (drizzle-kit, config em drizzle.config.ts → database `projeto_8509`) e é o
 * registro dinâmico da plataforma — o DynamicSchemaRegistry descobre
 * projects/<slug>/schema.ts no boot (readdir + import), sem whitelist estática.
 *
 * Fonte de verdade das 10 entidades: docs/ESPEC-CRUD.md (especificacaoCrud do
 * plano macro #10, geracoes_projeto.id=10). Requisitos: REQ-D-001..009 e a
 * camada de dados dos REQ-F citados no plano.
 *
 * Convenções aplicadas:
 * - Chaves das `annotations` = nome REAL da coluna no banco (snake_case): o
 *   gerarFields consulta `anotacoes[coluna.name]` — chaves camelCase são
 *   ignoradas silenciosamente (verificado contra packages/schema-tools).
 * - Campos de fluxo/status e readOnly recebem `disabled: true` na annotation
 *   (único mecanismo expressável em FormAnnotation; os flags finos
 *   insertable/editable/gridVisible pertencem ao DynamicFieldConfig do
 *   config.ts — subtarefa 2 da mesma tarefa macro). As transições de status
 *   só ocorrem no backend.
 * - `credenciaisCifradas` é write-only: annotation `sensitive: true`; a
 *   ocultação em respostas GET é aplicada pelo CRUD/API (hiddenColumns +
 *   projeção), nunca retornado ao painel.
 */
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
import {
  bigint,
  boolean,
  datetime,
  decimal,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core"

// ============================================================================
// VITRINE — conteúdo público parametrizável (planos, FAQ, métricas,
// segmentos, textos)
// ============================================================================

/** Planos comerciais exibidos na vitrine e selecionáveis no pedido. */
export const planos = mysqlTable(
  "planos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    nome: varchar("nome", { length: 120 }).notNull(),
    tagline: varchar("tagline", { length: 200 }),
    precoMensal: decimal("preco_mensal", { precision: 10, scale: 2 }).notNull(),
    precoSetup: decimal("preco_setup", { precision: 10, scale: 2 }),
    /** Lista de benefícios exibida como bullets no card do plano. */
    beneficios: json("beneficios"),
    textoBotao: varchar("texto_botao", { length: 60 }),
    maisPopular: boolean("mais_popular").notNull().default(false),
    ordem: int("ordem"),
    ativo: boolean("ativo").notNull().default(true),
  },
)

/** Itens de FAQ exibidos na vitrine. */
export const itensFaq = mysqlTable(
  "itens_faq",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    pergunta: text("pergunta").notNull(),
    resposta: text("resposta").notNull(),
    ordem: int("ordem"),
    ativo: boolean("ativo").notNull().default(true),
  },
)

/** Métricas de destaque (ex.: "24/7", "+120 atendentes"). */
export const metricasDestaque = mysqlTable(
  "metricas_destaque",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    valor: varchar("valor", { length: 30 }).notNull(),
    rotulo: varchar("rotulo", { length: 120 }),
    ordem: int("ordem"),
    ativo: boolean("ativo").notNull().default(true),
  },
)

/** Segmentos de atendimento exibidos na vitrine (barbearia, clínica…). */
export const segmentos = mysqlTable(
  "segmentos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    titulo: varchar("titulo", { length: 120 }).notNull(),
    descricao: text("descricao"),
    /** Nome do ícone (biblioteca da vitrine), ex.: "ContentCut". */
    icone: varchar("icone", { length: 60 }),
    ordem: int("ordem"),
    ativo: boolean("ativo").notNull().default(true),
  },
)

/** Textos livres da vitrine por chave única (hero_titulo, whatsapp_link…). */
export const textosVitrine = mysqlTable(
  "textos_vitrine",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    chave: varchar("chave", { length: 80 }).notNull(),
    conteudo: text("conteudo").notNull(),
    secao: mysqlEnum("secao", [
      "hero",
      "dores",
      "beneficios",
      "como_funciona",
      "cta",
      "contato",
    ]),
    ativo: boolean("ativo").notNull().default(true),
  },
  (tabela) => [unique("textos_vitrine_chave_unica").on(tabela.chave)],
)

// ============================================================================
// VENDAS — pedido de compra e documentos anexos
// ============================================================================

/**
 * Pedido de compra originado da vitrine pública.
 *
 * Campos de fluxo (status, pagamentoId, linkAgente, scriptEmbed) são
 * somente leitura no CRUD: transições apenas pelo backend (pagamento →
 * provisionamento). Consentimento LGPD é obrigatório no envio do formulário.
 */
export const pedidos = mysqlTable(
  "pedidos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    nomeNegocio: varchar("nome_negocio", { length: 160 }).notNull(),
    nomeContato: varchar("nome_contato", { length: 160 }).notNull(),
    email: varchar("email", { length: 160 }).notNull(),
    telefone: varchar("telefone", { length: 20 }).notNull(),
    planoId: bigint("plano_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => planos.id),
    ciclo: mysqlEnum("ciclo", ["mensal", "anual"]).notNull(),
    informacoesNegocio: text("informacoes_negocio"),
    status: mysqlEnum("status", [
      "criado",
      "aguardando_pagamento",
      "pago",
      "provisionando",
      "entregue",
      "falha",
    ])
      .notNull()
      .default("criado"),
    /** Identificador do pagamento no provedor (Mercado Pago) — write backend. */
    pagamentoId: varchar("pagamento_id", { length: 120 }),
    linkAgente: varchar("link_agente", { length: 300 }),
    scriptEmbed: text("script_embed"),
    consentimentoLgpd: boolean("consentimento_lgpd").notNull(),
    criadoEm: timestamp("criado_em").notNull().defaultNow(),
    emAtualizacao: timestamp("em_atualizacao")
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
)

/**
 * Documentos anexados ao pedido (conhecimento do atendente).
 * Upload físico é lacuna da plataforma tratada na tarefa 3 do plano; o
 * registro guarda metadados + texto extraído (write backend, readOnly aqui).
 */
export const documentos = mysqlTable(
  "documentos",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    pedidoId: bigint("pedido_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => pedidos.id),
    nomeOriginal: varchar("nome_original", { length: 255 }),
    mimeType: varchar("mime_type", { length: 120 }),
    tamanhoBytes: bigint("tamanho_bytes", { mode: "number" }),
    /** Caminho no armazenamento de arquivos — write backend. */
    caminhoArmazenamento: varchar("caminho_armazenamento", { length: 500 }),
    tipoConteudo: mysqlEnum("tipo_conteudo", [
      "pdf",
      "docx",
      "txt",
      "texto_livre",
    ]).notNull(),
    /** Texto extraído do documento (ingest) — write backend. */
    textoExtraido: longtext("texto_extraido"),
  },
)

// ============================================================================
// AGENTES — provisionamento, integrações e canal WhatsApp
// ============================================================================

/**
 * Agente provisionado a partir de um pedido pago.
 * Um agente por pedido (unique). Todos os campos além do vínculo são de fluxo
 * (write do pipeline de provisionamento), somente leitura no CRUD.
 */
export const agentesProvisionados = mysqlTable(
  "agentes_provisionados",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    pedidoId: bigint("pedido_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => pedidos.id),
    openclawAgenteId: varchar("openclaw_agente_id", { length: 120 }),
    nome: varchar("nome", { length: 160 }),
    status: mysqlEnum("status", [
      "pendente",
      "provisionando",
      "ativo",
      "falha",
    ])
      .notNull()
      .default("pendente"),
    /** Contrato de personalidade do agente (JSON versionado pelo pipeline). */
    personalidade: json("personalidade"),
    linkAcesso: varchar("link_acesso", { length: 300 }),
    scriptEmbed: text("script_embed"),
    tentativas: int("tentativas").notNull().default(0),
    ultimoErro: text("ultimo_erro"),
  },
  (tabela) => [unique("agentes_provisionados_pedido_unico").on(tabela.pedidoId)],
)

/**
 * Integrações externas do cliente (APIs consumidas pelo agente).
 * `credenciaisCifradas` é write-only: aceita gravação, nunca retorna em GET
 * (annotation sensitive + projeção do CRUD). Fase 1: somenteLeitura true.
 */
export const integracoesExternas = mysqlTable(
  "integracoes_externas",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    /** Vínculo com o pedido/cliente dono da integração. */
    pedidoId: bigint("pedido_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => pedidos.id),
    nome: varchar("nome", { length: 120 }).notNull(),
    urlBase: varchar("url_base", { length: 300 }).notNull(),
    tipoAutenticacao: mysqlEnum("tipo_autenticacao", [
      "api_key",
      "oauth2",
      "nenhuma",
    ]).notNull(),
    /** Cifrado em repouso; write-only — nunca retornado em respostas GET. */
    credenciaisCifradas: text("credenciais_cifradas"),
    /** Headers fixos enviados nas requisições (JSON). */
    headers: json("headers"),
    limiteRequisicoesMinuto: int("limite_requisicoes_minuto"),
    /** Fase 1: integrações são read-only por design. */
    somenteLeitura: boolean("somente_leitura").notNull().default(true),
    ativo: boolean("ativo").notNull().default(true),
  },
)

/**
 * Configuração do canal WhatsApp de um agente provisionado (um por agente).
 * Pareamento por QR e alcance de atendimento; status de pareamento é de fluxo.
 */
export const configuracoesWhatsapp = mysqlTable(
  "configuracoes_whatsapp",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .primaryKey()
      .autoincrement(),
    agenteId: bigint("agente_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agentesProvisionados.id),
    statusPareamento: mysqlEnum("status_pareamento", [
      "pendente",
      "qr_gerado",
      "pareado",
      "expirado",
    ])
      .notNull()
      .default("pendente"),
    alcance: mysqlEnum("alcance", ["todos", "whitelist"])
      .notNull()
      .default("todos"),
    /** Lista de números E.164 permitidos quando alcance = whitelist. */
    numerosPermitidos: json("numeros_permitidos"),
    ultimoQrGeradoEm: datetime("ultimo_qr_gerado_em"),
  },
  (tabela) => [unique("configuracoes_whatsapp_agente_unico").on(tabela.agenteId)],
)

// ============================================================================
// ANNOTATIONS DE FORMULÁRIO (PoC §7.2 — consumidas por coletarAnnotations /
// gerarFields). Chaves = nome REAL da coluna no banco (snake_case).
// readOnly/fluxo → disabled: true (transições só no backend);
// credenciaisCifradas → sensitive: true (write-only, oculta em GET).
// ============================================================================

export const annotations: FormAnnotationsPorTabela = {
  planos: {
    nome: { label: "Nome", required: true, maxLength: 120, fullWidth: true },
    tagline: { label: "Tagline", maxLength: 200, fullWidth: true },
    preco_mensal: {
      label: "Preço mensal",
      type: "money",
      currency: "BRL",
      required: true,
      min: 0,
    },
    preco_setup: {
      label: "Preço de setup",
      type: "money",
      currency: "BRL",
      min: 0,
    },
    beneficios: {
      label: "Benefícios",
      helperText: "Lista de benefícios exibida no card do plano",
    },
    texto_botao: { label: "Texto do botão", maxLength: 60 },
    mais_popular: { label: "Mais popular" },
    ordem: { label: "Ordem", helperText: "Ordenação na vitrine" },
    ativo: { label: "Ativo" },
  },
  itens_faq: {
    pergunta: {
      label: "Pergunta",
      type: "textarea",
      required: true,
      maxLength: 500,
      fullWidth: true,
    },
    resposta: {
      label: "Resposta",
      type: "textarea",
      required: true,
      fullWidth: true,
    },
    ordem: { label: "Ordem" },
    ativo: { label: "Ativo" },
  },
  metricas_destaque: {
    valor: { label: "Valor", required: true, maxLength: 30 },
    rotulo: { label: "Rótulo", maxLength: 120, fullWidth: true },
    ordem: { label: "Ordem" },
    ativo: { label: "Ativo" },
  },
  segmentos: {
    titulo: { label: "Título", required: true, maxLength: 120, fullWidth: true },
    descricao: { label: "Descrição", type: "textarea", fullWidth: true },
    icone: {
      label: "Ícone",
      maxLength: 60,
      helperText: "Nome do ícone exibido na vitrine",
    },
    ordem: { label: "Ordem" },
    ativo: { label: "Ativo" },
  },
  textos_vitrine: {
    chave: {
      label: "Chave",
      required: true,
      maxLength: 80,
      helperText: "Identificador único do texto (ex.: hero_titulo)",
    },
    conteudo: {
      label: "Conteúdo",
      type: "textarea",
      required: true,
      fullWidth: true,
    },
    secao: { label: "Seção" },
    ativo: { label: "Ativo" },
  },
  pedidos: {
    nome_negocio: {
      label: "Nome do negócio",
      required: true,
      maxLength: 160,
      fullWidth: true,
    },
    nome_contato: {
      label: "Nome do contato",
      required: true,
      maxLength: 160,
      validator: "nomeCompleto",
      fullWidth: true,
    },
    email: { label: "E-mail", type: "email", required: true },
    telefone: {
      label: "Telefone",
      required: true,
      maxLength: 20,
      mask: "telefone",
      validator: "telefone",
    },
    plano_id: { label: "Plano", required: true },
    ciclo: { label: "Ciclo de cobrança", required: true },
    informacoes_negocio: {
      label: "Informações do negócio",
      type: "textarea",
      fullWidth: true,
    },
    status: {
      label: "Status",
      disabled: true,
      helperText: "Transições somente pelo backend (pagamento/provisionamento)",
    },
    pagamento_id: {
      label: "ID do pagamento",
      disabled: true,
      helperText: "Preenchido pelo fluxo de pagamento",
    },
    link_agente: {
      label: "Link do agente",
      disabled: true,
      helperText: "Preenchido pelo provisionamento",
    },
    script_embed: {
      label: "Script de incorporação",
      type: "textarea",
      disabled: true,
      fullWidth: true,
      helperText: "Preenchido pelo provisionamento",
    },
    consentimento_lgpd: {
      label: "Consentimento LGPD",
      required: true,
      helperText: "Cliente aceitou o tratamento de dados no envio do pedido",
    },
    criado_em: { label: "Criado em", disabled: true },
    em_atualizacao: { label: "Atualizado em", disabled: true },
  },
  documentos: {
    pedido_id: { label: "Pedido", required: true },
    nome_original: { label: "Nome original", maxLength: 255, fullWidth: true },
    mime_type: { label: "Tipo MIME", maxLength: 120 },
    tamanho_bytes: { label: "Tamanho (bytes)", disabled: true },
    caminho_armazenamento: {
      label: "Caminho de armazenamento",
      disabled: true,
      fullWidth: true,
      helperText: "Preenchido pelo fluxo de upload",
    },
    tipo_conteudo: { label: "Tipo de conteúdo", required: true },
    texto_extraido: {
      label: "Texto extraído",
      type: "textarea",
      disabled: true,
      fullWidth: true,
      helperText: "Preenchido pelo ingest de documentos",
    },
  },
  agentes_provisionados: {
    pedido_id: { label: "Pedido", required: true },
    openclaw_agente_id: {
      label: "ID do agente OpenClaw",
      disabled: true,
      helperText: "Preenchido pelo pipeline de provisionamento",
    },
    nome: { label: "Nome", maxLength: 160, fullWidth: true },
    status: {
      label: "Status",
      disabled: true,
      helperText: "Transições somente pelo pipeline de provisionamento",
    },
    personalidade: {
      label: "Personalidade (contrato)",
      disabled: true,
      helperText: "Contrato JSON gerado pelo pipeline",
    },
    link_acesso: {
      label: "Link de acesso",
      disabled: true,
      helperText: "Preenchido pelo provisionamento",
    },
    script_embed: {
      label: "Script de incorporação",
      type: "textarea",
      disabled: true,
      fullWidth: true,
      helperText: "Preenchido pelo provisionamento",
    },
    tentativas: { label: "Tentativas", disabled: true },
    ultimo_erro: {
      label: "Último erro",
      type: "textarea",
      disabled: true,
      fullWidth: true,
    },
  },
  integracoes_externas: {
    pedido_id: { label: "Pedido (cliente)", required: true },
    nome: { label: "Nome", required: true, maxLength: 120, fullWidth: true },
    url_base: {
      label: "URL base",
      type: "text",
      required: true,
      maxLength: 300,
      fullWidth: true,
      helperText: "Validada no backend (URL absoluta)",
    },
    tipo_autenticacao: { label: "Tipo de autenticação", required: true },
    credenciais_cifradas: {
      label: "Credenciais (cifradas)",
      type: "textarea",
      sensitive: true,
      fullWidth: true,
      helperText:
        "Somente gravação: o valor nunca é retornado em consultas nem exibido no painel",
    },
    headers: { label: "Headers fixos" },
    limite_requisicoes_minuto: {
      label: "Limite de requisições/minuto",
      min: 1,
    },
    somente_leitura: {
      label: "Somente leitura",
      disabled: true,
      helperText: "Fase 1: integrações são read-only por design",
    },
    ativo: { label: "Ativo" },
  },
  configuracoes_whatsapp: {
    agente_id: { label: "Agente", required: true },
    status_pareamento: {
      label: "Status do pareamento",
      disabled: true,
      helperText: "Gerado pelo fluxo de pareamento QR",
    },
    alcance: { label: "Alcance" },
    numeros_permitidos: {
      label: "Números permitidos",
      helperText: "Lista E.164 obrigatória quando o alcance é whitelist",
    },
    ultimo_qr_gerado_em: {
      label: "Último QR gerado em",
      disabled: true,
    },
  },
}
