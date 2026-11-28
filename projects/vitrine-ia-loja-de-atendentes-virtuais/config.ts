/**
 * Config BASE versionada do projeto `vitrine-ia-loja-de-atendentes-virtuais`
 * (PoC §7, MANUAL_CONFIG_PROJETOS §1) — mesma fonte da config corrente no core
 * (projetos.config, id 8509, via `npm run db:seed`). Fonte de verdade do
 * modelo: ./schema.ts; especificação das telas: docs/ESPEC-CRUD.md (plano
 * macro #10, posição 1/11).
 *
 * Nomes de campo = PROPRIEDADE TS (camelCase), o contrato das linhas
 * retornadas pelo CRUD genérico (drizzle) e aceito no body via
 * normalizarChaves (mesma regra de projects/gestao-de-tarefas-global/config.ts).
 *
 * Decisões (ESPEC-CRUD):
 * - Grupos: Vitrine (Planos, FAQ, Métricas, Segmentos, Textos) · Vendas
 *   (Pedidos com childRoutes Documentos/Agente) · Agentes (Agentes
 *   Provisionados com childRoute WhatsApp + Integrações como tela própria do
 *   grupo, conforme menus do ESPEC-CRUD).
 * - Campos de fluxo (transições só no backend: pagamento → provisionamento →
 *   pareamento) recebem `insertable: false, editable: false` — a máquina de
 *   estados nunca é editável pelo painel: pedidos.status/pagamentoId/
 *   linkAgente/scriptEmbed, documentos.caminhoArmazenamento/textoExtraido,
 *   agentes_provisionados.openclawAgenteId/status/personalidade/linkAcesso/
 *   scriptEmbed/tentativas/ultimoErro, configuracoes_whatsapp.statusPareamento/
 *   ultimoQrGeradoEm, integracoes_externas.somenteLeitura (fase 1).
 * - `credenciaisCifradas` é write-only: nunca aparece em grid/detalhe
 *   (hiddenColumns; a projeção que omite a coluna em GET pertence ao CRUD).
 * - Upload de documentos e endpoints públicos NÃO entram aqui (tarefas
 *   seguintes do plano); documentos aparece como childRoute de pedidos com a
 *   grade de metadados (registro é editável, caminho/texto extraído não).
 * - Máscaras/validadores (telefone, nomeCompleto), money BRL pt-BR e selects
 *   de enum derivam do ESPEC-CRUD; unique de textos_vitrine.chave é garantido
 *   pelo backend (helperText orienta o operador).
 * - SYNC DE CONFIG (regra das duas fontes): versionado AQUI → core
 *   (projetos.config id 8509) via `npm run db:seed` (discover + upsert
 *   idempotente da config gerada por montarConfigInicial) — nunca SQL ad-hoc.
 * - Ícones restritos ao mapa resolveIcon() do front (grid, description,
 *   dashboard, groups, documentacao, viewlist, people, settings…).
 */
import {
  geradorSistemaConfigSchema,
  type GeradorSistemaConfig,
} from "@biblioteca-global/shared"

const configBase: GeradorSistemaConfig = {
  app: { name: "Vitrine IA — loja de atendentes virtuais", logo: "grid" },
  groups: [
    // ========================================================================
    // VITRINE — conteúdo público parametrizável
    // ========================================================================
    {
      id: "vitrine",
      label: "Vitrine",
      items: [
        {
          id: "planos",
          label: "Planos",
          path: "planos",
          icon: "grid",
          screen: {
            kind: "cadastro",
            resource: "planos",
            title: "Planos",
            description: "Planos comerciais exibidos na vitrine e selecionáveis no pedido",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 120, fullWidth: true },
              { name: "tagline", label: "Tagline", type: "text", required: false, maxLength: 200, fullWidth: true },
              {
                name: "precoMensal",
                label: "Preço mensal",
                type: "money",
                required: true,
                currency: "BRL",
                currencyLocale: "pt-BR",
                min: 0,
              },
              {
                name: "precoSetup",
                label: "Preço de setup",
                type: "money",
                required: false,
                currency: "BRL",
                currencyLocale: "pt-BR",
                min: 0,
              },
              {
                name: "beneficios",
                label: "Benefícios",
                type: "json",
                required: false,
                helperText: 'Lista de benefícios exibida como bullets no card. Ex.: ["Respostas 24/7", "Suporte por email"]',
              },
              { name: "textoBotao", label: "Texto do botão", type: "text", required: false, maxLength: 60 },
              { name: "maisPopular", label: "Mais popular", type: "switch", required: false },
              { name: "ordem", label: "Ordem", type: "number", required: false, helperText: "Ordenação na vitrine" },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              columnLabels: { id: "ID", precoMensal: "R$/mês", precoSetup: "Setup", textoBotao: "Botão" },
              newLabel: "Novo plano",
            },
            defaultOrderBy: [{ campo: "ordem", direction: "asc" }],
          },
        },
        {
          id: "itens_faq",
          label: "FAQ",
          path: "itens_faq",
          icon: "description",
          screen: {
            kind: "cadastro",
            resource: "itens_faq",
            title: "FAQ",
            description: "Perguntas frequentes exibidas na vitrine",
            fields: [
              { name: "pergunta", label: "Pergunta", type: "textarea", required: true, maxLength: 500, fullWidth: true },
              { name: "resposta", label: "Resposta", type: "textarea", required: true, fullWidth: true },
              { name: "ordem", label: "Ordem", type: "number", required: false, helperText: "Ordenação na vitrine" },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              columnLabels: { id: "ID" },
              newLabel: "Nova pergunta",
            },
            defaultOrderBy: [{ campo: "ordem", direction: "asc" }],
          },
        },
        {
          id: "metricas_destaque",
          label: "Métricas",
          path: "metricas_destaque",
          icon: "dashboard",
          screen: {
            kind: "cadastro",
            resource: "metricas_destaque",
            title: "Métricas de destaque",
            description: "Números de impacto exibidos na vitrine (ex.: 24/7, < 3s)",
            fields: [
              { name: "valor", label: "Valor", type: "text", required: true, maxLength: 30, helperText: "Ex.: 24/7" },
              { name: "rotulo", label: "Rótulo", type: "text", required: false, maxLength: 120, fullWidth: true },
              { name: "ordem", label: "Ordem", type: "number", required: false, helperText: "Ordenação na vitrine" },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              columnLabels: { id: "ID" },
              newLabel: "Nova métrica",
            },
            defaultOrderBy: [{ campo: "ordem", direction: "asc" }],
          },
        },
        {
          id: "segmentos",
          label: "Segmentos",
          path: "segmentos",
          icon: "groups",
          screen: {
            kind: "cadastro",
            resource: "segmentos",
            title: "Segmentos",
            description: "Segmentos de atendimento exibidos na vitrine (clínicas, imobiliárias…)",
            fields: [
              { name: "titulo", label: "Título", type: "text", required: true, maxLength: 120, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", required: false, fullWidth: true },
              {
                name: "icone",
                label: "Ícone",
                type: "text",
                required: false,
                maxLength: 60,
                helperText: "Nome do ícone exibido na vitrine",
              },
              { name: "ordem", label: "Ordem", type: "number", required: false, helperText: "Ordenação na vitrine" },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              columnLabels: { id: "ID" },
              newLabel: "Novo segmento",
            },
            defaultOrderBy: [{ campo: "ordem", direction: "asc" }],
          },
        },
        {
          id: "textos_vitrine",
          label: "Textos",
          path: "textos_vitrine",
          icon: "documentacao",
          screen: {
            kind: "cadastro",
            resource: "textos_vitrine",
            title: "Textos da vitrine",
            description: "Textos livres por chave única (hero_titulo, whatsapp_link…)",
            fields: [
              {
                name: "chave",
                label: "Chave",
                type: "text",
                required: true,
                maxLength: 80,
                helperText: "Identificador único do texto (ex.: hero_titulo). Chave repetida é recusada pelo backend.",
              },
              { name: "conteudo", label: "Conteúdo", type: "textarea", required: true, fullWidth: true },
              {
                name: "secao",
                label: "Seção",
                type: "select",
                required: false,
                options: [
                  { label: "Hero", value: "hero" },
                  { label: "Dores", value: "dores" },
                  { label: "Benefícios", value: "beneficios" },
                  { label: "Como funciona", value: "como_funciona" },
                  { label: "CTA", value: "cta" },
                  { label: "Contato", value: "contato" },
                ],
              },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              columnLabels: { id: "ID" },
              newLabel: "Novo texto",
            },
          },
        },
      ],
    },

    // ========================================================================
    // VENDAS — pedidos da vitrine
    // ========================================================================
    {
      id: "vendas",
      label: "Vendas",
      items: [
        {
          id: "pedidos",
          label: "Pedidos",
          path: "pedidos",
          icon: "viewlist",
          screen: {
            kind: "cadastro",
            resource: "pedidos",
            title: "Pedidos",
            description: "Pedidos originados da vitrine pública (campos de fluxo só o backend altera)",
            fields: [
              { name: "nomeNegocio", label: "Nome do negócio", type: "text", required: true, maxLength: 160, fullWidth: true },
              {
                name: "nomeContato",
                label: "Nome do contato",
                type: "text",
                required: true,
                maxLength: 160,
                validator: "nomeCompleto",
                fullWidth: true,
              },
              { name: "email", label: "E-mail", type: "email", required: true },
              {
                name: "telefone",
                label: "Telefone",
                type: "text",
                required: true,
                maxLength: 20,
                mask: "telefone",
                validator: "telefone",
              },
              {
                name: "planoId",
                label: "Plano",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "planos", idField: "id", displayField: "nome" },
              },
              {
                name: "ciclo",
                label: "Ciclo de cobrança",
                type: "select",
                required: true,
                options: [
                  { label: "Mensal", value: "mensal" },
                  { label: "Anual", value: "anual" },
                ],
              },
              { name: "informacoesNegocio", label: "Informações do negócio", type: "textarea", required: false, fullWidth: true },
              {
                // Fluxo: criado → aguardando_pagamento → pago → provisionando →
                // entregue/falha — transições só no backend.
                name: "status",
                label: "Status",
                type: "select",
                required: false,
                insertable: false,
                editable: false,
                options: [
                  { label: "Criado", value: "criado" },
                  { label: "Aguardando pagamento", value: "aguardando_pagamento" },
                  { label: "Pago", value: "pago" },
                  { label: "Provisionando", value: "provisionando" },
                  { label: "Entregue", value: "entregue" },
                  { label: "Falha", value: "falha" },
                ],
                helperText: "Transições somente pelo backend (pagamento/provisionamento)",
              },
              {
                name: "pagamentoId",
                label: "ID do pagamento",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
                helperText: "Preenchido pelo fluxo de pagamento",
              },
              {
                name: "linkAgente",
                label: "Link do agente",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
                helperText: "Preenchido pelo provisionamento",
              },
              {
                name: "scriptEmbed",
                label: "Script de incorporação",
                type: "textarea",
                required: false,
                insertable: false,
                editable: false,
                gridVisible: false,
                helperText: "Preenchido pelo provisionamento",
              },
              {
                name: "consentimentoLgpd",
                label: "Consentimento LGPD",
                type: "switch",
                required: true,
                helperText: "Cliente aceitou o tratamento de dados no envio do pedido",
              },
              {
                // Gerado pelo backend no pedido público (POST /api/vitrine/pedidos);
                // nunca editável pelo painel e oculto na interface gerada.
                name: "tokenAcompanhamento",
                label: "Token de acompanhamento",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
                gridVisible: false,
                helperText: "Gerado pelo backend; usado pelo cliente para acompanhar o pedido",
              },
            ],
            overrides: {
              hiddenColumns: ["criadoEm", "emAtualizacao", "tokenAcompanhamento"],
              columnLabels: { id: "ID", planoId: "Plano", pagamentoId: "Pagamento" },
              newLabel: "Novo pedido",
            },
            // Navegação contextual (ESPEC-CRUD): childRoutes com filtro
            // automático pelo pedido (filterField pedidoId).
            childRoutes: [
              {
                id: "documentos",
                label: "Documentos",
                icon: "description",
                targetResource: "documentos",
                filterField: "pedidoId",
                title: "Documentos do pedido",
                fields: [
                  {
                    name: "pedidoId",
                    label: "Pedido",
                    type: "multipleChoice",
                    required: true,
                    multipleChoice: { resource: "pedidos", idField: "id", displayField: "nomeNegocio" },
                  },
                  { name: "nomeOriginal", label: "Nome original", type: "text", required: false, maxLength: 255, fullWidth: true },
                  { name: "mimeType", label: "Tipo MIME", type: "text", required: false, maxLength: 120 },
                  { name: "tamanhoBytes", label: "Tamanho (bytes)", type: "number", required: false },
                  {
                    name: "caminhoArmazenamento",
                    label: "Caminho de armazenamento",
                    type: "text",
                    required: false,
                    insertable: false,
                    editable: false,
                    fullWidth: true,
                    helperText: "Preenchido pelo fluxo de upload",
                  },
                  {
                    name: "tipoConteudo",
                    label: "Tipo de conteúdo",
                    type: "select",
                    required: true,
                    options: [
                      { label: "PDF", value: "pdf" },
                      { label: "DOCX", value: "docx" },
                      { label: "TXT", value: "txt" },
                      { label: "Texto livre", value: "texto_livre" },
                    ],
                  },
                  {
                    name: "textoExtraido",
                    label: "Texto extraído",
                    type: "textarea",
                    required: false,
                    insertable: false,
                    editable: false,
                    gridVisible: false,
                    fullWidth: true,
                    helperText: "Preenchido pelo ingest de documentos",
                  },
                ],
                overrides: {
                  columnLabels: { id: "ID", pedidoId: "Pedido", tamanhoBytes: "Bytes", tipoConteudo: "Tipo" },
                  newLabel: "Novo documento",
                },
              },
              {
                id: "agente",
                label: "Agente",
                icon: "people",
                targetResource: "agentes_provisionados",
                filterField: "pedidoId",
                title: "Agente do pedido",
              },
            ],
          },
        },
      ],
    },

    // ========================================================================
    // AGENTES — provisionamento, integrações e canal WhatsApp
    // ========================================================================
    {
      id: "agentes",
      label: "Agentes",
      items: [
        {
          id: "agentes_provisionados",
          label: "Agentes Provisionados",
          path: "agentes_provisionados",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "agentes_provisionados",
            title: "Agentes Provisionados",
            description: "Agentes provisionados a partir de pedidos pagos (pipeline só no backend)",
            fields: [
              {
                name: "pedidoId",
                label: "Pedido",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "pedidos", idField: "id", displayField: "nomeNegocio" },
                helperText: "Um agente por pedido (vínculo único)",
              },
              {
                name: "openclawAgenteId",
                label: "ID do agente OpenClaw",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
                helperText: "Preenchido pelo pipeline de provisionamento",
              },
              { name: "nome", label: "Nome", type: "text", required: false, maxLength: 160, fullWidth: true },
              {
                name: "status",
                label: "Status",
                type: "select",
                required: false,
                insertable: false,
                editable: false,
                options: [
                  { label: "Pendente", value: "pendente" },
                  { label: "Provisionando", value: "provisionando" },
                  { label: "Ativo", value: "ativo" },
                  { label: "Falha", value: "falha" },
                ],
                helperText: "Transições somente pelo pipeline de provisionamento",
              },
              {
                name: "personalidade",
                label: "Personalidade (contrato)",
                type: "json",
                required: false,
                insertable: false,
                editable: false,
                gridVisible: false,
                helperText: "Contrato JSON gerado pelo pipeline",
              },
              {
                name: "linkAcesso",
                label: "Link de acesso",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
                helperText: "Preenchido pelo provisionamento",
              },
              {
                name: "scriptEmbed",
                label: "Script de incorporação",
                type: "textarea",
                required: false,
                insertable: false,
                editable: false,
                gridVisible: false,
                fullWidth: true,
                helperText: "Preenchido pelo provisionamento",
              },
              { name: "tentativas", label: "Tentativas", type: "number", required: false, insertable: false, editable: false },
              {
                name: "ultimoErro",
                label: "Último erro",
                type: "textarea",
                required: false,
                insertable: false,
                editable: false,
                gridVisible: false,
                fullWidth: true,
              },
            ],
            overrides: {
              columnLabels: { id: "ID", pedidoId: "Pedido", openclawAgenteId: "Agente OpenClaw" },
              newLabel: "Novo agente",
            },
            childRoutes: [
              {
                id: "configuracoes_whatsapp",
                label: "WhatsApp",
                icon: "settings",
                targetResource: "configuracoes_whatsapp",
                filterField: "agenteId",
                title: "Configuração WhatsApp",
                fields: [
                  {
                    name: "agenteId",
                    label: "Agente",
                    type: "multipleChoice",
                    required: true,
                    multipleChoice: { resource: "agentes_provisionados", idField: "id", displayField: "nome" },
                    helperText: "Uma configuração por agente (vínculo único)",
                  },
                  {
                    name: "statusPareamento",
                    label: "Status do pareamento",
                    type: "select",
                    required: false,
                    insertable: false,
                    editable: false,
                    options: [
                      { label: "Pendente", value: "pendente" },
                      { label: "QR gerado", value: "qr_gerado" },
                      { label: "Pareado", value: "pareado" },
                      { label: "Expirado", value: "expirado" },
                    ],
                    helperText: "Gerado pelo fluxo de pareamento QR",
                  },
                  {
                    name: "alcance",
                    label: "Alcance",
                    type: "select",
                    required: false,
                    defaultValue: "todos",
                    options: [
                      { label: "Todos", value: "todos" },
                      { label: "Whitelist", value: "whitelist" },
                    ],
                  },
                  {
                    name: "numerosPermitidos",
                    label: "Números permitidos",
                    type: "json",
                    required: false,
                    helperText: 'Lista E.164 obrigatória quando o alcance é whitelist. Ex.: ["+5521988161553"]',
                  },
                  {
                    name: "ultimoQrGeradoEm",
                    label: "Último QR gerado em",
                    type: "date",
                    required: false,
                    insertable: false,
                    editable: false,
                  },
                ],
                overrides: {
                  columnLabels: { id: "ID", agenteId: "Agente", statusPareamento: "Pareamento", ultimoQrGeradoEm: "QR gerado em" },
                  newLabel: "Nova configuração",
                },
              },
            ],
          },
        },
        {
          id: "integracoes_externas",
          label: "Integrações",
          path: "integracoes_externas",
          icon: "settings",
          screen: {
            kind: "cadastro",
            resource: "integracoes_externas",
            title: "Integrações Externas",
            description: "APIs consumidas pelos agentes — fase 1: somente leitura por design",
            fields: [
              {
                name: "pedidoId",
                label: "Pedido (cliente)",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "pedidos", idField: "id", displayField: "nomeNegocio" },
              },
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 120, fullWidth: true },
              {
                name: "urlBase",
                label: "URL base",
                type: "text",
                required: true,
                maxLength: 300,
                fullWidth: true,
                helperText: "URL absoluta, validada no backend",
              },
              {
                name: "tipoAutenticacao",
                label: "Tipo de autenticação",
                type: "select",
                required: true,
                options: [
                  { label: "API key", value: "api_key" },
                  { label: "OAuth2", value: "oauth2" },
                  { label: "Nenhuma", value: "nenhuma" },
                ],
              },
              {
                // Write-only: aceita gravação, nunca retorna em GET (projeção
                // do CRUD) e não aparece em grid/detalhe (hiddenColumns).
                name: "credenciaisCifradas",
                label: "Credenciais (cifradas)",
                type: "textarea",
                required: false,
                gridVisible: false,
                fullWidth: true,
                helperText: "Somente gravação: o valor nunca é retornado em consultas nem exibido no painel",
              },
              {
                name: "headers",
                label: "Headers fixos",
                type: "json",
                required: false,
                helperText: 'Objeto JSON enviado em todas as requisições. Ex.: {"X-Fonte": "vitrine"}',
              },
              { name: "limiteRequisicoesMinuto", label: "Limite de requisições/minuto", type: "number", required: false, min: 1 },
              {
                name: "somenteLeitura",
                label: "Somente leitura",
                type: "switch",
                required: false,
                insertable: false,
                editable: false,
                helperText: "Fase 1: integrações são read-only por design",
              },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["credenciaisCifradas"],
              columnLabels: { id: "ID", pedidoId: "Cliente", urlBase: "URL", tipoAutenticacao: "Auth", limiteRequisicoesMinuto: "Limite/min" },
              newLabel: "Nova integração",
            },
          },
        },
      ],
    },
  ],
}

/**
 * Validação em runtime da mesma fonte que o registry da web consome.
 * A tela sistêmica de Usuários é injetada pela plataforma e, por isso, não
 * pertence aos grupos de negócio deste projeto.
 */
export const config = geradorSistemaConfigSchema.parse(configBase)
