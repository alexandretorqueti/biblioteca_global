/**
 * Config BASE versionada do projeto `sistema-adm-global` — Administrador Global.
 *
 * Plataforma da Global Tecnologia para gestão administrativa:
 * - Dashboard com saudação e circulares (custom)
 * - Hubs de navegação: Administrativo, RH e Painel Admin (custom)
 * - Clientes (cadastro completo com endereço e contato)
 * - Contatos do site (mensagens recebidas)
 * - Circulares (comunicados internos)
 * - Configurações: Usuários, Empresa, Departamentos
 *
 * Menus: Início | Administrativo | RH | Configurações Admin | Sair
 * Telas: 4 custom (dashboard + 3 hubs de navegação) + CRUDs cadastro
 *
 * A tela Usuários é CRUD local (tabela usuarios no database do projeto).
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Administrador Global", logo: "admin_panel_settings" },
  groups: [
    // ========================================================================
    // MENU: Início (1 tela)
    // ========================================================================
    {
      id: "inicio",
      label: "Início",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          path: "dashboard",
          icon: "home",
          screen: {
            kind: "custom",
            componentId: "sistema-adm-global-dashboard",
          },
        },
      ],
    },

    // ========================================================================
    // MENU: Administrativo (hub + clientes + contatos)
    // ========================================================================
    {
      id: "administrativo",
      label: "Administrativo",
      items: [
        {
          id: "hub-administrativo",
          label: "Hub Administrativo",
          path: "hub-administrativo",
          icon: "dashboard",
          screen: {
            kind: "custom",
            componentId: "sistema-adm-global-hub-administrativo",
          },
        },
        {
          id: "clientes-list",
          label: "Clientes",
          path: "clientes",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "clientes",
            title: "Clientes Cadastrados",
            description: "Gerenciamento de empresas clientes",
            fields: [
              { name: "nomeFantasia", label: "Nome Fantasia", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "razaoSocial", label: "Razão Social", type: "text", required: true, maxLength: 300, fullWidth: true, gridVisible: false },
              { name: "cnpj", label: "CNPJ", type: "text", required: true, maxLength: 18, mask: "cnpj", validator: "cnpj" },
              { name: "inscricaoMunicipal", label: "Inscrição Municipal", type: "text", maxLength: 50, gridVisible: false },
              { name: "inscricaoEstadual", label: "Inscrição Estadual", type: "text", maxLength: 50, gridVisible: false },
              { name: "logradouro", label: "Logradouro", type: "text", required: true, maxLength: 200, fullWidth: true, gridVisible: false },
              { name: "numero", label: "Número", type: "text", required: true, maxLength: 20, gridVisible: false },
              { name: "complemento", label: "Complemento", type: "text", maxLength: 100, gridVisible: false },
              { name: "bairro", label: "Bairro", type: "text", required: true, maxLength: 100, gridVisible: false },
              { name: "cidade", label: "Cidade", type: "text", required: true, maxLength: 100, gridVisible: false },
              { name: "uf", label: "UF", type: "text", required: true, maxLength: 2, gridVisible: false },
              { name: "cep", label: "CEP", type: "text", required: true, maxLength: 10, gridVisible: false },
              { name: "telefone", label: "Telefone", type: "text", required: true, maxLength: 30 },
              { name: "ramal", label: "Ramal", type: "text", maxLength: 10, gridVisible: false },
              { name: "email", label: "E-mail", type: "email", required: true, maxLength: 200, fullWidth: true },
              { name: "ativo", label: "Cliente Ativo", type: "switch", defaultValue: true, gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt", "inscricaoMunicipal", "inscricaoEstadual", "ramal", "complemento", "administradorId"],
              columnLabels: {
                id: "ID",
                nomeFantasia: "Nome Fantasia",
                cnpj: "CNPJ",
                telefone: "Telefone",
                ativo: "Status",
              },
              newLabel: "Novo Cliente",
            },
            childRoutes: [
              {
                id: "responsaveis",
                label: "Responsáveis",
                icon: "person",
                targetResource: "responsaveis",
                filterField: "clienteId",
                title: "Responsáveis do Cliente",
                fields: [
                  { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
                  { name: "cargo", label: "Cargo", type: "text", maxLength: 100 },
                  { name: "telefone", label: "Telefone", type: "text", maxLength: 30 },
                  { name: "email", label: "E-mail", type: "email", maxLength: 200, fullWidth: true },
                ],
                overrides: {
                  newLabel: "Novo Responsável",
                  hiddenColumns: ["clienteId", "createdAt", "updatedAt"],
                  columnLabels: { id: "ID", nome: "Nome", cargo: "Cargo" },
                },
              },
              {
                id: "contratos",
                label: "Contratos",
                icon: "description",
                targetResource: "contratos",
                filterField: "clienteId",
                title: "Contratos do Cliente",
                fields: [
                  { name: "numero", label: "Número", type: "text", required: true, maxLength: 50 },
                  { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
                  { name: "valor", label: "Valor", type: "text", maxLength: 30 },
                  { name: "inicio", label: "Início", type: "text", maxLength: 10 },
                  { name: "fim", label: "Fim", type: "text", maxLength: 10 },
                  { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
                ],
                overrides: {
                  newLabel: "Novo Contrato",
                  hiddenColumns: ["clienteId", "createdAt", "updatedAt"],
                  columnLabels: { id: "ID", numero: "Número", valor: "Valor", ativo: "Status" },
                },
              },
            ],
          },
        },
        {
          id: "contatos-site",
          label: "Contatos do Site",
          path: "contato",
          icon: "mail",
          screen: {
            kind: "cadastro",
            resource: "contatos_site",
            title: "Contatos Recebidos",
            description: "Mensagens recebidas pelo site",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200 },
              { name: "email", label: "E-mail", type: "email", required: true, maxLength: 200 },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 30 },
              { name: "assunto", label: "Assunto", type: "text", required: true, maxLength: 200 },
              { name: "mensagem", label: "Mensagem", type: "textarea", required: true, fullWidth: true, gridVisible: false },
            ],
            overrides: {
              hiddenColumns: [],
              columnLabels: {
                id: "ID",
                nome: "Nome",
                email: "E-mail",
                telefone: "Telefone",
                assunto: "Assunto",
                dataEnvio: "Data",
              },
              newLabel: "Novo Contato",
            },
          },
        },
      ],
    },

    // ========================================================================
    // MENU: RH (hub + circulares)
    // ========================================================================
    {
      id: "rh",
      label: "RH",
      items: [
        {
          id: "hub-rh",
          label: "Hub RH",
          path: "hub-rh",
          icon: "dashboard",
          screen: {
            kind: "custom",
            componentId: "sistema-adm-global-hub-rh",
          },
        },
        {
          id: "circulares-list",
          label: "Circulares",
          path: "circular",
          icon: "campaign",
          screen: {
            kind: "cadastro",
            resource: "circulares",
            title: "Circulares",
            description: "Comunicados internos da empresa",
            fields: [
              { name: "titulo", label: "Título", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "imageUrl", label: "URL da Imagem", type: "text", maxLength: 500, fullWidth: true, gridVisible: false },
              { name: "conteudo", label: "Conteúdo", type: "textarea", required: true, maxLength: 5000, fullWidth: true, gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["updatedAt", "imageUrl", "createdAt"],
              columnLabels: {
                id: "ID",
                titulo: "Título",
                publicadoEm: "Data",
              },
              newLabel: "Nova Circular",
            },
          },
        },
      ],
    },

    // ========================================================================
    // MENU: Configurações Admin (hub + usuarios + config empresa + departamentos)
    // ========================================================================
    {
      id: "config-admin",
      label: "Configurações Admin",
      items: [
        {
          id: "hub-admin",
          label: "Painel Admin",
          path: "hub-admin",
          icon: "settings",
          screen: {
            kind: "custom",
            componentId: "sistema-adm-global-hub-admin",
          },
        },
        {
          id: "usuarios-list",
          label: "Usuários",
          path: "usuarios",
          icon: "manage_accounts",
          screen: {
            kind: "cadastro",
            resource: "usuarios",
            title: "Usuários do Sistema",
            description: "Gerenciamento de usuários e permissões",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "email", label: "E-mail", type: "email", required: true, maxLength: 200, fullWidth: true },
              { name: "senhaInicial", label: "Senha inicial", type: "text", required: true, minLength: 8, fullWidth: true },
              { name: "perfil", label: "Perfil", type: "select", required: true, options: [{ value: "admin", label: "Administrador" }, { value: "gerente", label: "Gerente" }, { value: "operador", label: "Operador" }, { value: "visualizador", label: "Visualizador" }] },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                nome: "Nome",
                email: "E-mail",
                perfil: "Perfil",
                ativo: "Status",
              },
              newLabel: "Novo Usuário",
            },
          },
        },
        {
          id: "config-empresa",
          label: "Empresa",
          path: "config-empresa",
          icon: "business",
          screen: {
            kind: "cadastro",
            resource: "config_empresa",
            title: "Configurações da Empresa",
            description: "Dados e configurações da empresa",
            fields: [
              { name: "nome", label: "Nome da Empresa", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "logoUrl", label: "URL da Logo", type: "text", maxLength: 500, fullWidth: true, gridVisible: false },
              { name: "endereco", label: "Endereço", type: "text", maxLength: 300, fullWidth: true, gridVisible: false },
              { name: "cnpj", label: "CNPJ", type: "text", maxLength: 18, gridVisible: false },
              { name: "telefone", label: "Telefone", type: "text", maxLength: 30, gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", nome: "Empresa" },
              newLabel: "Nova Configuração",
            },
          },
        },
        {
          id: "departamentos-list",
          label: "Departamentos",
          path: "departamento",
          icon: "apartment",
          screen: {
            kind: "cadastro",
            resource: "departamentos",
            title: "Departamentos",
            description: "Departamentos da empresa",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 50, fullWidth: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", nome: "Nome" },
              newLabel: "Novo Departamento",
            },
          },
        },
      ],
    },

    // ========================================================================
    // MENU: Sair (nenhuma tela — logout é ação da plataforma)
    // ========================================================================
    {
      id: "sair",
      label: "Sair",
      items: [],
    },
  ],
}
