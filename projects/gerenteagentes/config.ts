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
import {
  TASK_STATUS_FINAIS,
  SUBTASK_STATUS_OPTIONS,
} from "./motor-v2/src/shared/task-statuses"

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
        {
          id: "isa-chat-view",
          label: "Conversar com a Isa",
          path: "isa-chat",
          icon: "smart_toy",
          screen: {
            kind: "custom",
            componentId: "gerenteagentes-isa-chat",
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
              { name: "nome", label: "Nome", type: "text", required: true, maxLength: 200, fullWidth: true },
              { name: "slug", label: "Slug", type: "text", required: true, minLength: 2, maxLength: 100, helperText: "Use letras minúsculas, números e hífen.", gridVisible: false },
              { name: "agenteId", label: "Agente vinculado", type: "select", gridVisible: true, helperText: "Agente que executará as tarefas deste projeto. O motor usa COALESCE(openclaw_agent_id, nome) para abrir a sessão.", optionsResource: { resource: "agentes", idField: "id", displayField: "nome" } },
              { name: "descricao", label: "Descrição / Regras do projeto", type: "textarea", maxLength: 65535, fullWidth: true, gridVisible: false },
              { name: "regras", label: "Regras extras (complementam a descrição)", type: "textarea", maxLength: 65535, fullWidth: true, gridVisible: false },
              { name: "contatoId", label: "Contato responsável", type: "number", gridVisible: false, helperText: "ID do contato em projeto_640.contatos." },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: true },
              { name: "plataformaProjetoId", label: "ID na plataforma (core.projetos)", type: "number", gridVisible: false, helperText: "Vínculo com core.projetos.id. Usado pela biblioteca para rotear API." },
              // Campos do projeto_motor_config (configuração operacional do motor)
              { name: "repoPath", label: "Caminho do repositório", type: "text", maxLength: 500, gridVisible: false, fullWidth: true, helperText: "Caminho absoluto no host (ex.: /data/workspace/projects/codigofonte/biblioteca-global)." },
              { name: "branchTrabalho", label: "Branch de trabalho", type: "text", maxLength: 255, gridVisible: false, helperText: "Branch base para worktrees do motor (ex.: base-desenvolvimento)." },
              { name: "buildCommand", label: "Comando de build", type: "text", maxLength: 500, gridVisible: false, fullWidth: true, helperText: "Comando para build do projeto (ex.: npm run build)." },
              { name: "unitTestCommand", label: "Comando de testes", type: "text", maxLength: 500, gridVisible: false, fullWidth: true, helperText: "Comando para testes (ex.: npm run test)." },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                nome: "Nome",
                slug: "Slug",
                agenteId: "Agente",
                descricao: "Descrição",
                regras: "Regras",
                contatoId: "Contato",
                ativo: "Ativo",
                plataformaProjetoId: "Plataforma",
                branchTrabalho: "Branch",
                repoPath: "Repositório",
              },
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
                id: "modelos",
                label: "Modelos",
                icon: "model_training",
                targetResource: "projetos_captados",
                componentId: "gerenteagentes-model-selection",
                filterField: "projetoId",
                title: "Fila de Modelos",
              },
              {
                id: "tarefas",
                label: "Tarefas",
                icon: "task_alt",
                targetResource: "tarefas",
                filterField: "projetoId",
                title: "Tarefas do Projeto",
                defaultOrderBy: [
                  {
                    campo: "status",
                    direction: "asc",
                    valuesLast: [...TASK_STATUS_FINAIS].filter((s) =>
                      ["completed", "deployed", "cancelled", "failed", "blocked"].includes(s),
                    ),
                  },
                  { campo: "createdAt", direction: "desc" },
                ],
                fields: [
                  { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
                  {
                    name: "dependsOnTaskId",
                    label: "Depende de",
                    type: "multipleChoice",
                    multipleChoice: { resource: "tarefas", idField: "id", displayField: "titulo" },
                    gridVisible: false,
                  },
                  // Agente e ambiente de execução (repoPath/buildCommand/unitTestCommand)
                  // agora vivem em projetos_captados — o motor resolve via projeto.
                  { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true, gridVisible: false },
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
                        name: "dependsOnSubtaskId",
                        label: "Depende de",
                        type: "multipleChoice",
                        multipleChoice: { resource: "subtarefas", idField: "id", displayField: "titulo" },
                        gridVisible: false,
                      },
                      {
                        name: "status",
                        label: "Status",
                        type: "select",
                        options: SUBTASK_STATUS_OPTIONS.map((o) => ({
                          label: o.label.replace(/ \(.*\)$/, ""),
                          value: o.value,
                        })),
                        defaultValue: "pending",
                      },
                      { name: "seq", label: "Ordem", type: "number", defaultValue: 0, gridVisible: false },
                      { name: "scope", label: "Escopo", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "acceptanceCriteria", label: "Critérios de aceite (JSON)", type: "textarea", fullWidth: true, gridVisible: false },
                      { name: "resultado", label: "Resultado", type: "textarea", fullWidth: true, gridVisible: false },
                    ],
                    overrides: {
                      newLabel: "Nova subtarefa",
                      hiddenColumns: [
                        "tarefaId",
                        "descricao",
                        "deliverCount",
                        "duracaoSegundos",
                        "iniciadaEm",
                        "finalizadaEm",
                        "workspacePath",
                        "workspaceBranch",
                        "workspaceBaseCommit",
                        "workspaceCommitSha",
                        "workspaceStatus",
                        "workspaceCreatedAt",
                        "workspaceCleanedAt",
                        "correctionForSubtaskId",
                        "correctionFingerprint",
                        "correctionCreatedAt",
                        "createdAt",
                        "updatedAt",
                      ],
                      columnLabels: { id: "ID", titulo: "Título", status: "Status", scope: "Escopo" },
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
