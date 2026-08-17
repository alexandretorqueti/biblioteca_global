/**
 * Config BASE versionada do projeto `gerenteagentes` (piloto).
 *
 * Piloto para gerenciamento de agentes de IA:
 * - Cadastro de agentes e tarefas (master-detail com execuções)
 * - Tela externa do motor de execução (http://192.168.1.16:6283)
 * - Tela Projetos externa (GET /api/projects → dataPath "projects")
 * - Tela Tarefas externa (GET /api/projects/:agentId/tasks → detail /task/:id)
 * - Ação "Iniciar tarefa" na tela de tarefas
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
              { name: "modelo", label: "Modelo", type: "text", required: true },
              { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true },
            ],
            overrides: {
              newLabel: "Novo agente",
            },
          },
        },
      ],
    },
    {
      id: "tarefas",
      label: "Tarefas",
      items: [
        {
          id: "nova-tarefa",
          label: "Nova tarefa",
          path: "nova-tarefa",
          icon: "add_task",
          screen: {
            kind: "custom",
            componentId: "gerenteagentes-nova-tarefa",
          },
        },
        {
          id: "tarefas-list",
          label: "Tarefas",
          path: "tarefas",
          icon: "task_alt",
          screen: {
            kind: "cadastro",
            resource: "tarefas",
            title: "Tarefas",
            description: "Gerenciamento de tarefas dos agentes",
            fields: [
              { name: "agenteId", label: "Agente (ID)", type: "number", required: true },
              { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true },
              { name: "status", label: "Status", type: "select", defaultValue: "pendente" },
              { name: "prioridade", label: "Prioridade", type: "number" },
            ],
            overrides: {
              newLabel: "Nova tarefa",
            },
            /**
             * Master-detail: execuções como child de tarefas.
             * fkField = "tarefaId" — cada execução referencia tarefas.id.
             */
            children: [
              {
                childResource: "execucoes",
                fkField: "tarefaId",
                label: "Execuções",
              },
            ],
            /**
             * Ação personalizada: iniciar tarefa no motor externo.
             */
            actions: [
              {
                id: "iniciar-tarefa",
                label: "Iniciar tarefa",
                method: "POST",
                path: "/task/:id/start",
                confirm: "Deseja iniciar esta tarefa no motor de execução?",
              },
            ],
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
            kind: "external",
            baseUrl: "http://192.168.1.16:6283",
            method: "GET",
            pathTemplate: "/api/projects",
            dataPath: "projects",
          },
        },
      ],
    },
    {
      id: "definicoes",
      label: "Definições e Contatos",
      items: [
        {
          id: "definicoes-list",
          label: "Definições",
          path: "definicoes",
          icon: "category",
          screen: {
            kind: "external",
            baseUrl: "http://192.168.1.16:6283",
            method: "GET",
            pathTemplate: "/api/projects/:slug/definitions",
            dataPath: "definitions",
          },
        },
        {
          id: "contatos-list",
          label: "Contatos",
          path: "contatos",
          icon: "contacts",
          screen: {
            kind: "external",
            baseUrl: "http://192.168.1.16:6283",
            method: "GET",
            pathTemplate: "/api/contatos",
            dataPath: "contatos",
            query: {
              filtro: "todos",
            },
          },
        },
      ],
    },
  ],
}
