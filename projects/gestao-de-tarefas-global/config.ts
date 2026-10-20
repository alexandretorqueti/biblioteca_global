import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

const cadastro = (resource: string, label: string, path = resource) => ({
  id: `${resource}-list`,
  label,
  path,
  icon: "list",
  screen: { kind: "cadastro" as const, resource },
})

export const config: GeradorSistemaConfig = {
  app: { name: "Gestão de Tarefas Global", logo: "task_alt" },
  groups: [
    {
      id: "operacao",
      label: "Operação",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          path: "dashboard",
          icon: "dashboard",
          screen: { kind: "custom", componentId: "gestao-de-tarefas-global-dashboard" },
        },
        cadastro("tarefas", "Tarefas"),
        cadastro("atribuicoes", "Atribuições"),
        cadastro("lembretes", "Lembretes"),
      ],
    },
    {
      id: "cadastros",
      label: "Cadastros",
      items: [
        cadastro("areas", "Áreas"),
        cadastro("tags", "Tags"),
        cadastro("recorrencias", "Recorrências"),
        cadastro("comentarios", "Comentários"),
        cadastro("anexos", "Anexos"),
        cadastro("historico_tarefas", "Histórico de tarefas", "historico-tarefas"),
        cadastro("tarefas_tags", "Tags das tarefas", "tarefas-tags"),
      ],
    },
  ],
}
