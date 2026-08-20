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
              { name: "agenteId", label: "Agente", type: "multipleChoice", multipleChoice: { resource: "agentes", idField: "id", displayField: "nome" }, gridVisible: true },
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
                childRoutes: [
                  {
                    id: "subtarefas",
                    label: "Subtarefas",
                    icon: "subtasks",
                    targetResource: "subtarefas",
                    filterField: "tarefaId",
                  },
                  {
                    id: "tarefa-chats",
                    label: "Chats da Tarefa",
                    icon: "chat",
                    targetResource: "tarefa_chats",
                    filterField: "tarefaId",
                  },
                  {
                    id: "bloqueios",
                    label: "Bloqueios",
                    icon: "block",
                    targetResource: "bloqueios",
                    filterField: "tarefaId",
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
                  { name: "texto", label: "Texto", type: "textarea", required: true, fullWidth: true },
                  { name: "seq", label: "Ordem", type: "number", defaultValue: 0 },
                ],
                overrides: {
                  newLabel: "Nova definição",
                },
              },
              {
                id: "projeto-chats",
                label: "Chats do Projeto",
                icon: "chat",
                targetResource: "projeto_chats",
                filterField: "projetoId",
                title: "Chats do Projeto",
              },
            ],
          },
        },
      ],
    },
  ],
}
