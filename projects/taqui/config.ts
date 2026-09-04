/**
 * Config BASE versionada do projeto `taqui` — controle de encomendas multi-condomínio.
 *
 * Domínio:
 * - Cadastros: condomínios, unidades, moradores, proprietários, funcionários, transportadoras
 * - Operações: encomendas (registro, confirmação, entrega)
 * - Morador: notificações, histórico de encomendas
 *
 * Telas CRUD puro (kind: "cadastro"):
 * - condominios, unidades, moradores, proprietarios, funcionarios, transportadoras
 * - encomendas (grid com filtros por status/condomínio/unidade)
 * - notificacoes (grid para admin; morador vê via tela custom)
 * - unidades_proprietarios (vínculo N:N, acessível como childRoute de unidades)
 *
 * Telas custom (kind: "custom") — exigem implementação React específica:
 * - taqui-registro-encomenda: registro com foto (câmera) e leitura de código de barras/QR code
 * - taqui-notificacoes-morador: sininho — encomendas pendentes + histórico (inclui confirmação de reconhecimento pelo morador)
 * - taqui-painel-portaria: visão da portaria/triagem com encomendas do dia
 *
 * Navegação hierárquica:
 * - Condomínio → Unidades → Moradores
 * - Condomínio → Funcionários
 * - Condomínio → Encomendas (com filtros)
 * - Unidade → Encomendas (filtradas pela unidade)
 * - Morador → Encomendas (filtradas pelo morador via unidade)
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "TaQui", logo: "package" },
  groups: [
    // ========================================================================
    // CADASTROS
    // ========================================================================
    {
      id: "cadastros",
      label: "Cadastros",
      items: [
        {
          id: "condominios-list",
          label: "Condomínios",
          path: "condominios",
          icon: "apartment",
          screen: {
            kind: "cadastro",
            resource: "condominios",
            title: "Condomínios",
            description: "Cadastre os condomínios gerenciados pelo sistema",
            fields: [
              { name: "nome", label: "Nome do Condomínio", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "endereco", label: "Endereço", type: "text", required: true, maxLength: 500, fullWidth: true },
              { name: "tipo", label: "Tipo de Estrutura", type: "select", required: true, options: [
                { label: "Vertical (Apartamentos)", value: "vertical" },
                { label: "Horizontal (Casas)", value: "horizontal" },
              ] },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                nome: "Nome",
                endereco: "Endereço",
                tipo: "Tipo",
                ativo: "Ativo",
              },
              newLabel: "Novo condomínio",
            },
            childRoutes: [
              {
                id: "unidades",
                label: "Unidades",
                icon: "meeting_room",
                targetResource: "unidades",
                filterField: "condominioId",
                title: "Unidades do Condomínio",
                fields: [
                  { name: "tipo", label: "Tipo", type: "select", required: true, options: [
                    { label: "Apartamento", value: "apartamento" },
                    { label: "Casa", value: "casa" },
                  ] },
                  { name: "rua", label: "Rua", type: "text", maxLength: 200 },
                  { name: "bloco", label: "Bloco", type: "text", maxLength: 50, helperText: "Apenas apartamentos" },
                  { name: "andar", label: "Andar", type: "number", helperText: "Apenas apartamentos" },
                  { name: "numero", label: "Número", type: "text", maxLength: 20 },
                  { name: "quadra", label: "Quadra", type: "text", maxLength: 50, helperText: "Apenas casas" },
                  { name: "lote", label: "Lote", type: "text", maxLength: 50, helperText: "Apenas casas" },
                  { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
                ],
                overrides: {
                  hiddenColumns: ["condominioId", "label", "createdAt", "updatedAt"],
                  columnLabels: {
                    id: "ID",
                    tipo: "Tipo",
                    rua: "Rua",
                    bloco: "Bloco",
                    andar: "Andar",
                    numero: "Nº",
                    quadra: "Quadra",
                    lote: "Lote",
                    ativo: "Ativo",
                  },
                  newLabel: "Nova unidade",
                },
                childRoutes: [
                  {
                    id: "moradores",
                    label: "Moradores",
                    icon: "people",
                    targetResource: "moradores",
                    filterField: "unidadeId",
                    title: "Moradores da Unidade",
                    fields: [
                      { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
                      { name: "email", label: "E-mail", type: "text", maxLength: 200, fullWidth: true },
                      { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
                      { name: "cpf", label: "CPF", type: "text", maxLength: 14 },
                      { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
                    ],
                    overrides: {
                      hiddenColumns: ["unidadeId", "createdAt", "updatedAt"],
                      columnLabels: { id: "ID", nome: "Nome", email: "E-mail", telefone: "Telefone", ativo: "Ativo" },
                      newLabel: "Novo morador",
                    },
                  },
                  {
                    id: "unidade-encomendas",
                    label: "Encomendas",
                    icon: "inventory_2",
                    targetResource: "encomendas",
                    filterField: "unidadeId",
                    title: "Encomendas da Unidade",
                    defaultOrderBy: [
                      { campo: "status", direction: "asc", valuesLast: ["entregue", "cancelada"] },
                      { campo: "createdAt", direction: "desc" },
                    ],
                    overrides: {
                      hiddenColumns: ["condominioId", "unidadeId", "observacoes", "fotoUrl", "createdAt", "updatedAt"],
                      columnLabels: {
                        id: "ID",
                        status: "Status",
                        transportadoraId: "Loja",
                        registradoPorId: "Registrado por",
                        codigoRastreamento: "Rastreamento",
                        confirmadoPorId: "Confirmado por",
                        confirmadoEm: "Confirmado em",
                        entreguePorId: "Entregue por",
                        entregueEm: "Entregue em",
                      },
                    },
                  },
                ],
              },
              {
                id: "funcionarios",
                label: "Funcionários",
                icon: "badge",
                targetResource: "funcionarios",
                filterField: "condominioId",
                title: "Funcionários do Condomínio",
                fields: [
                  { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
                  { name: "funcao", label: "Função", type: "select", required: true, options: [
                    { label: "Triagem", value: "triagem" },
                    { label: "Portaria", value: "portaria" },
                    { label: "Ambos", value: "ambos" },
                  ] },
                  { name: "email", label: "E-mail", type: "text", maxLength: 200, fullWidth: true },
                  { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
                  { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
                ],
                overrides: {
                  hiddenColumns: ["condominioId", "createdAt", "updatedAt"],
                  columnLabels: { id: "ID", nome: "Nome", funcao: "Função", email: "E-mail", telefone: "Telefone", ativo: "Ativo" },
                  newLabel: "Novo funcionário",
                },
              },
              {
                id: "condominio-encomendas",
                label: "Encomendas",
                icon: "inventory_2",
                targetResource: "encomendas",
                filterField: "condominioId",
                title: "Encomendas do Condomínio",
                defaultOrderBy: [
                  { campo: "status", direction: "asc", valuesLast: ["entregue", "cancelada"] },
                  { campo: "createdAt", direction: "desc" },
                ],
                overrides: {
                  hiddenColumns: ["observacoes", "fotoUrl", "createdAt", "updatedAt"],
                  columnLabels: {
                    id: "ID",
                    status: "Status",
                    unidadeId: "Unidade",
                    transportadoraId: "Loja",
                    registradoPorId: "Registrado por",
                    codigoRastreamento: "Rastreamento",
                    confirmadoPorId: "Confirmado por",
                    confirmadoEm: "Confirmado em",
                    entreguePorId: "Entregue por",
                    entregueEm: "Entregue em",
                  },
                },
              },
            ],
          },
        },
        {
          id: "unidades-list",
          label: "Unidades",
          path: "unidades",
          icon: "meeting_room",
          screen: {
            kind: "cadastro",
            resource: "unidades",
            title: "Unidades",
            description: "Apartamentos e casas de todos os condomínios",
            fields: [
              { name: "condominioId", label: "Condomínio", type: "multipleChoice", multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }, required: true },
              { name: "tipo", label: "Tipo", type: "select", required: true, options: [
                { label: "Apartamento", value: "apartamento" },
                { label: "Casa", value: "casa" },
              ] },
              { name: "rua", label: "Rua", type: "text", maxLength: 200 },
              { name: "bloco", label: "Bloco", type: "text", maxLength: 50 },
              { name: "andar", label: "Andar", type: "number" },
              { name: "numero", label: "Número", type: "text", maxLength: 20 },
              { name: "quadra", label: "Quadra", type: "text", maxLength: 50 },
              { name: "lote", label: "Lote", type: "text", maxLength: 50 },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["label", "createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                condominioId: "Condomínio",
                tipo: "Tipo",
                rua: "Rua",
                bloco: "Bloco",
                andar: "Andar",
                numero: "Nº",
                quadra: "Quadra",
                lote: "Lote",
                ativo: "Ativo",
              },
              newLabel: "Nova unidade",
            },
            childRoutes: [
              {
                id: "proprietarios-vinculo",
                label: "Proprietários",
                icon: "home_work",
                targetResource: "unidades_proprietarios",
                filterField: "unidadeId",
                title: "Proprietários da Unidade",
                fields: [
                  { name: "proprietarioId", label: "Proprietário", type: "multipleChoice", multipleChoice: { resource: "proprietarios", idField: "id", displayField: "nome" }, required: true },
                ],
                overrides: {
                  hiddenColumns: ["unidadeId", "createdAt"],
                  columnLabels: { id: "ID", proprietarioId: "Proprietário" },
                  newLabel: "Vincular proprietário",
                },
              },
            ],
          },
        },
        {
          id: "moradores-list",
          label: "Moradores",
          path: "moradores",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "moradores",
            title: "Moradores",
            description: "Todos os moradores de todos os condomínios",
            fields: [
              { name: "unidadeId", label: "Unidade", type: "multipleChoice", multipleChoice: { resource: "unidades", idField: "id", displayField: "label" }, required: true },
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "email", label: "E-mail", type: "text", maxLength: 200, fullWidth: true },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
              { name: "cpf", label: "CPF", type: "text", maxLength: 14 },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", unidadeId: "Unidade", nome: "Nome", email: "E-mail", telefone: "Telefone", cpf: "CPF", ativo: "Ativo" },
              newLabel: "Novo morador",
            },
          },
        },
        {
          id: "proprietarios-list",
          label: "Proprietários",
          path: "proprietarios",
          icon: "home_work",
          screen: {
            kind: "cadastro",
            resource: "proprietarios",
            title: "Proprietários",
            description: "Proprietários de unidades (quando diferentes dos moradores)",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "email", label: "E-mail", type: "text", maxLength: 200, fullWidth: true },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
              { name: "cpf", label: "CPF", type: "text", maxLength: 14 },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", nome: "Nome", email: "E-mail", telefone: "Telefone", cpf: "CPF", ativo: "Ativo" },
              newLabel: "Novo proprietário",
            },
          },
        },
        {
          id: "funcionarios-list",
          label: "Funcionários",
          path: "funcionarios",
          icon: "badge",
          screen: {
            kind: "cadastro",
            resource: "funcionarios",
            title: "Funcionários",
            description: "Funcionários de triagem e portaria de todos os condomínios",
            fields: [
              { name: "condominioId", label: "Condomínio", type: "multipleChoice", multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }, required: true },
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "funcao", label: "Função", type: "select", required: true, options: [
                { label: "Triagem", value: "triagem" },
                { label: "Portaria", value: "portaria" },
                { label: "Ambos", value: "ambos" },
              ] },
              { name: "email", label: "E-mail", type: "text", maxLength: 200, fullWidth: true },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", condominioId: "Condomínio", nome: "Nome", funcao: "Função", email: "E-mail", telefone: "Telefone", ativo: "Ativo" },
              newLabel: "Novo funcionário",
            },
          },
        },
        {
          id: "transportadoras-list",
          label: "Transportadoras / Lojas",
          path: "transportadoras",
          icon: "local_shipping",
          screen: {
            kind: "cadastro",
            resource: "transportadoras",
            title: "Transportadoras / Lojas",
            description: "Lojas e transportadoras que enviam encomendas",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "cnpj", label: "CNPJ", type: "text", maxLength: 18 },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 50 },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", nome: "Nome", cnpj: "CNPJ", telefone: "Telefone", ativo: "Ativo" },
              newLabel: "Nova transportadora",
            },
          },
        },
      ],
    },

    // ========================================================================
    // OPERAÇÕES
    // ========================================================================
    {
      id: "operacoes",
      label: "Operações",
      items: [
        {
          id: "encomendas-list",
          label: "Encomendas",
          path: "encomendas",
          icon: "inventory_2",
          screen: {
            kind: "cadastro",
            resource: "encomendas",
            title: "Encomendas",
            description: "Todas as encomendas registradas no sistema",
            fields: [
              { name: "condominioId", label: "Condomínio", type: "multipleChoice", multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }, required: true },
              { name: "unidadeId", label: "Unidade", type: "multipleChoice", multipleChoice: { resource: "unidades", idField: "id", displayField: "label" }, required: true },
              { name: "transportadoraId", label: "Transportadora / Loja", type: "multipleChoice", multipleChoice: { resource: "transportadoras", idField: "id", displayField: "nome" } },
              { name: "registradoPorId", label: "Registrado por (funcionário)", type: "multipleChoice", multipleChoice: { resource: "funcionarios", idField: "id", displayField: "nome" }, required: true },
              { name: "codigoRastreamento", label: "Código de Rastreamento", type: "text", maxLength: 100, fullWidth: true },
              { name: "fotoUrl", label: "URL da Foto", type: "text", maxLength: 1000, fullWidth: true, gridVisible: false },
              { name: "observacoes", label: "Observações", type: "textarea", fullWidth: true, gridVisible: false },
              {
                name: "status",
                label: "Status",
                type: "select",
                defaultValue: "pendente",
                options: [
                  { label: "Pendente", value: "pendente" },
                  { label: "Confirmada", value: "confirmada" },
                  { label: "Entregue", value: "entregue" },
                  { label: "Cancelada", value: "cancelada" },
                ],
              },
              { name: "confirmadoPorId", label: "Confirmado por (morador)", type: "multipleChoice", multipleChoice: { resource: "moradores", idField: "id", displayField: "nome" }, gridVisible: false },
              { name: "confirmadoEm", label: "Confirmado em", type: "date", gridVisible: false },
              { name: "entreguePorId", label: "Entregue por (funcionário)", type: "multipleChoice", multipleChoice: { resource: "funcionarios", idField: "id", displayField: "nome" }, gridVisible: false },
              { name: "entregueEm", label: "Entregue em", type: "date", gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["fotoUrl", "observacoes", "createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                condominioId: "Condomínio",
                unidadeId: "Unidade",
                transportadoraId: "Loja",
                registradoPorId: "Registrado por",
                codigoRastreamento: "Rastreamento",
                status: "Status",
                confirmadoPorId: "Confirmado por",
                confirmadoEm: "Confirmado em",
                entreguePorId: "Entregue por",
                entregueEm: "Entregue em",
              },
              newLabel: "Nova encomenda",
            },
            defaultOrderBy: [
              { campo: "status", direction: "asc", valuesLast: ["entregue", "cancelada"] },
              { campo: "createdAt", direction: "desc" },
            ],
            rowActions: [
              {
                id: "confirmar-recebimento",
                label: "Confirmar Recebimento",
                method: "PUT",
                path: "/api/encomendas/:id/confirmar",
                confirm: "Confirmar que o morador recebeu esta encomenda?",
                disabledWhen: "status === entregue || status === cancelada",
              },
              {
                id: "registrar-entrega",
                label: "Registrar Entrega",
                method: "PUT",
                path: "/api/encomendas/:id/entregar",
                confirm: "Registrar entrega efetiva desta encomenda?",
                disabledWhen: "status !== confirmada",
              },
            ],
          },
        },
        {
          id: "notificacoes-list",
          label: "Notificações",
          path: "notificacoes",
          icon: "notifications",
          screen: {
            kind: "cadastro",
            resource: "notificacoes",
            title: "Notificações",
            description: "Histórico de notificações enviadas aos moradores",
            fields: [
              { name: "moradorId", label: "Morador", type: "multipleChoice", multipleChoice: { resource: "moradores", idField: "id", displayField: "nome" }, required: true },
              { name: "encomendaId", label: "Encomenda", type: "multipleChoice", multipleChoice: { resource: "encomendas", idField: "id", displayField: "codigoRastreamento" }, required: true },
              {
                name: "tipo",
                label: "Tipo",
                type: "select",
                required: true,
                options: [
                  { label: "Encomenda Pendente", value: "encomenda_pendente" },
                  { label: "Encomenda Confirmada", value: "encomenda_confirmada" },
                  { label: "Encomenda Entregue", value: "encomenda_entregue" },
                ],
              },
              { name: "mensagem", label: "Mensagem", type: "text", required: true, maxLength: 500, fullWidth: true },
              { name: "lida", label: "Lida", type: "switch", defaultValue: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt"],
              columnLabels: {
                id: "ID",
                moradorId: "Morador",
                encomendaId: "Encomenda",
                tipo: "Tipo",
                mensagem: "Mensagem",
                lida: "Lida",
              },
              newLabel: "Nova notificação",
            },
            defaultOrderBy: [
              { campo: "createdAt", direction: "desc" },
            ],
          },
        },
      ],
    },

    // ========================================================================
    // TELAS CUSTOM (exigem implementação React específica)
    // ========================================================================
    {
      id: "telas-especiais",
      label: "Ações Rápidas",
      items: [
        {
          id: "registro-encomenda",
          label: "Registrar Encomenda",
          path: "registrar",
          icon: "add_photo_alternate",
          screen: {
            kind: "custom",
            componentId: "taqui-registro-encomenda",
          },
        },
        {
          id: "painel-portaria",
          label: "Painel da Portaria",
          path: "portaria",
          icon: "desk",
          screen: {
            kind: "custom",
            componentId: "taqui-painel-portaria",
          },
        },
        {
          id: "minhas-encomendas",
          label: "Minhas Encomendas",
          path: "minhas-encomendas",
          icon: "inbox",
          screen: {
            kind: "custom",
            componentId: "taqui-notificacoes-morador",
          },
        },
      ],
    },
  ],
}
