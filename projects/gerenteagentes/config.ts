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
 *
 * Convenções das grids (decisão 2026-08-20):
 * - Grid enxuta: somente ID + 1-2 campos mais importantes (nome/título/status).
 * - Campos restantes: `gridVisible: false` (aparecem apenas no formulário).
 * - Colunas de controle do motor que não são de formulário: `hiddenColumns`.
 * - `columnLabels` ajusta os títulos dos cabeçalhos da grid.
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
        {
          id: "acompanhar-view",
          label: "Acompanhar Tarefa",
          path: "acompanhar",
          icon: "monitor_heart",
          screen: {
            kind: "custom",
            componentId: "gerenteagentes-task-monitor",
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
              columnLabels: { id: "ID", nome: "Nome" },
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
              { name: "contatoId", label: "Contato", type: "number", gridVisible: false },
              { name: "agenteId", label: "Agente", type: "multipleChoice", multipleChoice: { resource: "agentes", idField: "id", displayField: "nome" }, gridVisible: false },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: false },
              { name: "plataformaProjetoId", label: "Projeto Plataforma", type: "number", gridVisible: false },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", nome: "Nome" },
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
                  { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
                  {
                    name: "agenteId",
                    label: "Agente",
                    type: "multipleChoice",
                    multipleChoice: { resource: "agentes", idField: "id", displayField: "nome" },
                    required: true,
                    gridVisible: false,
                  },
                  { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
                  { name: "repoPath", label: "Caminho do Repo", type: "text", fullWidth: true, placeholder: "/data/workspace/projects/...", gridVisible: false },
                  { name: "buildCommand", label: "Comando de Build", type: "text", placeholder: "npm run build", gridVisible: false },
                  { name: "unitTestCommand", label: "Comando de Teste", type: "text", placeholder: "npm run test", gridVisible: false },
                ],
                overrides: {
                  newLabel: "Nova tarefa",
                  hiddenColumns: [
                    "projetoId",
                    "maxRework",
                    "hardTimeoutMs",
                    "dependsOnTaskId",
                    "autoStart",
                    "bootRetryCount",
                    "createdAt",
                    "updatedAt",
                  ],
                  columnLabels: { id: "ID", titulo: "Título", status: "Status" },
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
                childRoutes: [
                  {
                    id: "subtarefas",
                    label: "Subtarefas",
                    icon: "subtasks",
                    targetResource: "subtarefas",
                    filterField: "tarefaId",
                    title: "Subtarefas da Tarefa",
                    fields: [
                      { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
                      {
                        name: "status",
                        label: "Status",
                        type: "select",
                        options: [
                          { label: "Pendente", value: "pending" },
                          { label: "Executando", value: "running" },
                          { label: "Verificada", value: "verified" },
                          { label: "Falhou", value: "failed" },
                        ],
                        defaultValue: "pending",
                      },
                      { name: "seq", label: "Ordem", type: "number", defaultValue: 0, gridVisible: false },
                      { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "resultado", label: "Resultado", type: "textarea", fullWidth: true, gridVisible: false },
                    ],
                    overrides: {
                      newLabel: "Nova subtarefa",
                      hiddenColumns: [
                        "tarefaId",
                        "scope",
                        "acceptanceCriteria",
                        "deliverCount",
                        "duracaoSegundos",
                        "iniciadaEm",
                        "finalizadaEm",
                        "createdAt",
                        "updatedAt",
                      ],
                      columnLabels: { id: "ID", titulo: "Título", status: "Status" },
                    },
                  },
                  {
                    id: "tarefa-chats",
                    label: "Chats da Tarefa",
                    icon: "chat",
                    targetResource: "tarefa_chats",
                    filterField: "tarefaId",
                    title: "Chats da Tarefa",
                    fields: [
                      {
                        name: "role",
                        label: "Role",
                        type: "select",
                        required: true,
                        options: [
                          { label: "User", value: "user" },
                          { label: "Assistant", value: "assistant" },
                          { label: "System", value: "system" },
                          { label: "Analyst", value: "analyst" },
                        ],
                      },
                      { name: "texto", label: "Mensagem", type: "textarea", required: true, fullWidth: true, gridVisible: false },
                    ],
                    overrides: {
                      newLabel: "Nova mensagem",
                      hiddenColumns: ["tarefaId", "createdAt"],
                      columnLabels: { id: "ID", role: "Role", texto: "Mensagem" },
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
                      { name: "blockReason", label: "Razão do bloqueio", type: "textarea", fullWidth: true },
                      { name: "blockCommand", label: "Comando", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "blockExitCode", label: "Exit Code", type: "number", gridVisible: false },
                      { name: "blockExcerpt", label: "Excerto do erro", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "blockedAt", label: "Bloqueado em", type: "date" },
                    ],
                    overrides: {
                      newLabel: "Novo bloqueio",
                      hiddenColumns: ["tarefaId", "subtarefaId", "createdAt"],
                      columnLabels: { id: "ID", blockReason: "Razão", blockedAt: "Bloqueado em" },
                    },
                  },
                ],
              },
              {
                id: "definicoes",
                label: "Definições",
                icon: "description",
                targetResource: "definicoes",
                filterField: "projetoId",
                title: "Definições do Projeto",
                fields: [
                  { name: "texto", label: "Definição", type: "textarea", required: true, fullWidth: true },
                  { name: "seq", label: "Ordem", type: "number", defaultValue: 0, gridVisible: false },
                ],
                overrides: {
                  newLabel: "Nova definição",
                  hiddenColumns: ["projetoId", "createdAt", "updatedAt"],
                  columnLabels: { id: "ID", texto: "Definição", seq: "Ordem" },
                },
              },
              {
                id: "projeto-chats",
                label: "Chats do Projeto",
                icon: "chat",
                targetResource: "projeto_chats",
                filterField: "projetoId",
                title: "Chats do Projeto",
                fields: [
                  {
                    name: "role",
                    label: "Role",
                    type: "select",
                    required: true,
                    options: [
                      { label: "User", value: "user" },
                      { label: "Assistant", value: "assistant" },
                      { label: "System", value: "system" },
                      { label: "Analyst", value: "analyst" },
                    ],
                  },
                  { name: "texto", label: "Mensagem", type: "textarea", required: true, fullWidth: true, gridVisible: false },
                ],
                overrides: {
                  newLabel: "Nova mensagem",
                  hiddenColumns: ["projetoId", "createdAt"],
                  columnLabels: { id: "ID", role: "Role", texto: "Mensagem" },
                },
              },
            ],
          },
        },
      ],
    },
  ],
}
