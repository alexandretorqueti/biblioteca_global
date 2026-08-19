/**
 * Config BASE versionada do projeto `gerenteagentes`.
 *
 * Gerenciamento de agentes de IA com fluxo completo:
 * - Captação: contatos, projetos, definições (via Isa ou manual)
 * - Execução: tarefas com subtarefas, chats, start/pause/resume
 * - Geração macro: analista forte gera tarefas a partir de definições
 * 
 * Navegação hierárquica:
 * - Projetos → Tarefas → Subtarefas / Chats de Tarefa / Bloqueios
 * - Projetos → Definições
 * - Projetos → Chats de Projeto
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Gerente Agentes", logo: "smart_toy" },
  groups: [
    {
      id: "dashboard",
      label: "Dashboard",
      items: [
        {
          id: "dashboard-view",
          label: "Dashboard",
          path: "dashboard",
          icon: "dashboard",
          screen: {
            kind: "custom",
            componentId: "gerenteagentes-dashboard",
          },
        },
      ],
    },
    {
      id: "agentes",
      label: "Agentes",
      items: [
        {
          id: "agentes-list",
          label: "Agentes",
          path: "agentes",
          icon: "smart_toy",
          screen: {
            kind: "cadastro",
            resource: "agentes",
            title: "Agentes",
            description: "Gerenciamento de agentes de IA",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
              { name: "modelo", label: "Modelo", type: "text", required: true, gridVisible: false },
              { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo agente",
            },
          },
        },
      ],
    },
    {
      id: "projetos",
      label: "Projetos",
      items: [
        {
          id: "projetos-list",
          label: "Projetos",
          path: "projetos",
          icon: "account_tree",
          screen: {
            kind: "cadastro",
            resource: "projetos_captados",
            title: "Projetos",
            description: "Projetos captados pela Isa ou criados manualmente",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
              { name: "slug", label: "Slug", type: "text", required: true, gridVisible: false },
              { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
              { name: "regras", label: "Regras", type: "textarea", fullWidth: true, gridVisible: false },
              { name: "contatoId", label: "Contato (ID)", type: "number", gridVisible: false },
              { name: "agenteId", label: "Agente (ID)", type: "number", gridVisible: false },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: false },
              { name: "plataformaProjetoId", label: "Projeto Plataforma (ID)", type: "number", gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo projeto",
            },
            rowActions: [
              {
                id: "iniciar-desenvolvimento",
                label: "Iniciar Desenvolvimento",
                method: "POST",
                path: "/api/gerenteagentes/projetos-captados/:id/desenvolvimento",
                confirm: "Iniciar desenvolvimento deste projeto? Isso criará o projeto na plataforma.",
              },
            ],
            // Rotas filhas com contexto (navegação hierárquica)
            childRoutes: [
              {
                id: "tarefas",
                label: "Tarefas",
                icon: "task_alt",
                targetResource: "tarefas",
                filterField: "projetoId",
                title: "Tarefas do Projeto",
                fields: [
                  { name: "projetoId", label: "Projeto", type: "multipleChoice", required: true, multipleChoice: { resource: "projetos_captados", idField: "id", displayField: "nome" }, gridVisible: false },
                  { name: "agenteId", label: "Agente", type: "multipleChoice", required: true, multipleChoice: { resource: "agentes", idField: "id", displayField: "nome" }, gridVisible: false },
                  { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
                  { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
                  { name: "repoPath", label: "Repo Path", type: "text", fullWidth: true, gridVisible: false },
                  { name: "buildCommand", label: "Build Command", type: "text", gridVisible: false },
                  { name: "unitTestCommand", label: "Test Command", type: "text", gridVisible: false },
                  { name: "status", label: "Status", type: "select", options: [
                    { value: "draft", label: "Rascunho" },
                    { value: "planned", label: "Planejada" },
                    { value: "running", label: "Em execução" },
                    { value: "paused", label: "Pausada" },
                    { value: "completed", label: "Concluída" },
                    { value: "failed", label: "Falhou" },
                    { value: "cancelled", label: "Cancelada" },
                  ]},
                  { name: "maxRework", label: "Max Retrabalho", type: "number", defaultValue: 3, gridVisible: false },
                  { name: "hardTimeoutMs", label: "Timeout (ms)", type: "number", gridVisible: false },
                  { name: "dependsOnTaskId", label: "Depende de (ID)", type: "number", gridVisible: false },
                  { name: "autoStart", label: "Auto Start", type: "switch", defaultValue: false, gridVisible: false },
                ],
                overrides: {
                  hiddenColumns: ["createdAt", "updatedAt"],
                  newLabel: "Nova tarefa",
                },
                rowActions: [
                  {
                    id: "iniciar-tarefa",
                    label: "Iniciar",
                    method: "POST",
                    path: "/api/gerenteagentes/tarefas/:id/start",
                    confirm: "Iniciar execução desta tarefa?",
                  },
                  {
                    id: "pausar-tarefa",
                    label: "Pausar",
                    method: "POST",
                    path: "/api/gerenteagentes/tarefas/:id/pause",
                    confirm: "Pausar esta tarefa?",
                  },
                  {
                    id: "retomar-tarefa",
                    label: "Retomar",
                    method: "POST",
                    path: "/api/gerenteagentes/tarefas/:id/resume",
                    confirm: "Retomar execução desta tarefa?",
                  },
                ],
                // Rotas filhas das tarefas
                childRoutes: [
                  {
                    id: "subtarefas",
                    label: "Subtarefas",
                    icon: "subtasks",
                    targetResource: "subtarefas",
                    filterField: "tarefaId",
                    title: "Subtarefas da Tarefa",
                    fields: [
                      { name: "tarefaId", label: "Tarefa (ID)", type: "number", required: true, gridVisible: false },
                      { name: "seq", label: "Sequência", type: "number", required: true, gridVisible: false },
                      { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
                      { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "status", label: "Status", type: "select", options: [
                        { value: "pending", label: "Pendente" },
                        { value: "running", label: "Em execução" },
                        { value: "verified", label: "Verificada" },
                        { value: "failed", label: "Falhou" },
                      ]},
                      { name: "resultado", label: "Resultado", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "duracaoSegundos", label: "Duração (s)", type: "number", gridVisible: false },
                    ],
                    overrides: {
                      hiddenColumns: ["createdAt", "updatedAt"],
                      newLabel: "Nova subtarefa",
                    },
                  },
                  {
                    id: "tarefa-chats",
                    label: "Chats",
                    icon: "forum",
                    targetResource: "tarefa_chats",
                    filterField: "tarefaId",
                    title: "Chats da Tarefa",
                    fields: [
                      { name: "tarefaId", label: "Tarefa (ID)", type: "number", required: true, gridVisible: false },
                      { name: "role", label: "Role", type: "select", options: [
                        { value: "user", label: "User" },
                        { value: "assistant", label: "Assistant" },
                        { value: "system", label: "System" },
                        { value: "analyst", label: "Analyst" },
                      ], required: true },
                      { name: "texto", label: "Mensagem", type: "textarea", required: true, fullWidth: true },
                    ],
                    overrides: {
                      hiddenColumns: ["createdAt", "updatedAt"],
                      newLabel: "Nova mensagem",
                    },
                  },
                  {
                    id: "bloqueios",
                    label: "Bloqueios",
                    icon: "block",
                    targetResource: "bloqueios",
                    filterField: "tarefaId",
                    title: "Bloqueios da Tarefa",
                    fields: [
                      { name: "tarefaId", label: "Tarefa (ID)", type: "number", required: true, gridVisible: false },
                      { name: "blockReason", label: "Razão", type: "textarea", fullWidth: true },
                      { name: "blockCommand", label: "Comando", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "blockExitCode", label: "Exit Code", type: "number", gridVisible: false },
                      { name: "blockExcerpt", label: "Excerto", type: "textarea", fullWidth: true, gridVisible: false },
                    ],
                    overrides: {
                      hiddenColumns: ["createdAt", "updatedAt"],
                      newLabel: "Novo bloqueio",
                    },
                  },
                ],
              },
              {
                id: "definicoes",
                label: "Definições",
                icon: "category",
                targetResource: "definicoes",
                filterField: "projetoId",
                title: "Definições do Projeto",
                fields: [
                  { name: "projetoId", label: "Projeto (ID)", type: "number", required: true, gridVisible: false },
                  { name: "texto", label: "Definição", type: "textarea", required: true, fullWidth: true },
                  { name: "seq", label: "Ordem", type: "number", defaultValue: 0, gridVisible: false },
                ],
                overrides: {
                  hiddenColumns: ["createdAt", "updatedAt"],
                  newLabel: "Nova definição",
                },
              },
              {
                id: "projeto-chats",
                label: "Chats",
                icon: "groups",
                targetResource: "projeto_chats",
                filterField: "projetoId",
                title: "Chats do Projeto",
                fields: [
                  { name: "projetoId", label: "Projeto (ID)", type: "number", required: true, gridVisible: false },
                  { name: "role", label: "Role", type: "select", options: [
                    { value: "user", label: "User" },
                    { value: "assistant", label: "Assistant" },
                    { value: "system", label: "System" },
                    { value: "analyst", label: "Analyst" },
                  ], required: true },
                  { name: "texto", label: "Mensagem", type: "textarea", required: true, fullWidth: true },
                ],
                overrides: {
                  hiddenColumns: ["createdAt", "updatedAt"],
                  newLabel: "Nova mensagem",
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chats-isa",
      label: "Chats",
      items: [
        {
          id: "chats-isa-list",
          label: "Chats da Isa",
          path: "chats-isa",
          icon: "chat",
          screen: {
            kind: "cadastro",
            resource: "chats",
            title: "Chats da Isa",
            description: "Chats de captação da Isa com clientes",
            fields: [
              { name: "contatoId", label: "Contato", type: "multipleChoice", multipleChoice: { resource: "contatos", idField: "id", displayField: "nome" } },
              { name: "projetoId", label: "Projeto", type: "multipleChoice", multipleChoice: { resource: "projetos_captados", idField: "id", displayField: "nome" }, gridVisible: false },
              { name: "status", label: "Status", type: "select", options: [
                { value: "aberto", label: "Aberto" },
                { value: "em_andamento", label: "Em andamento" },
                { value: "finalizado", label: "Finalizado" },
              ]},
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo chat",
            },
            childRoutes: [
              {
                id: "conversas",
                label: "Conversas",
                icon: "forum",
                targetResource: "chat_mensagens",
                filterField: "chatId",
                title: "Conversas do Chat",
                fields: [
                  { name: "chatId", label: "Chat (ID)", type: "number", required: true, gridVisible: false },
                  { name: "role", label: "Role", type: "select", options: [
                    { value: "user", label: "User" },
                    { value: "agent", label: "Agent" },
                    { value: "system", label: "System" },
                  ], required: true },
                  { name: "texto", label: "Mensagem", type: "textarea", required: true, fullWidth: true },
                ],
                overrides: {
                  hiddenColumns: ["createdAt", "updatedAt"],
                  newLabel: "Nova mensagem",
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "contatos",
      label: "Contatos",
      items: [
        {
          id: "contatos-list",
          label: "Contatos",
          path: "contatos",
          icon: "contacts",
          screen: {
            kind: "cadastro",
            resource: "contatos",
            title: "Contatos",
            description: "Contatos capturados pela Isa ou cadastrados manualmente",
            fields: [
              { name: "nome", label: "Nome", type: "text", fullWidth: true },
              { name: "email", label: "Email", type: "email", required: true, fullWidth: true },
              { name: "telefone", label: "Telefone", type: "text", gridVisible: false },
              { name: "origem", label: "Origem", type: "text", gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo contato",
            },
          },
        },
      ],
    },
  ],
}
