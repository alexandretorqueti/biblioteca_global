// @vitest-environment node
/**
 * Valida a configuração do projeto `gerenteagentes` — em especial as telas
 * externas que falam com a API do motor (GerenteAgentes), atendendo à st-5
 * "Corrigir action iniciar-tarefa para POST /api/task/:id/start".
 *
 * IMPORTANTE (histórico): a verificação desta action já foi feita uma vez com
 * `node --input-type=module -e "import config from '.../config.ts'"`, que FALHA
 * com "Unexpected token 'export'" porque `projects/*` é `"type": "commonjs"` e o
 * Node puro não transpila TS. Este teste roda sob o Vitest (que transpila), então
 * o contrato fica validado de forma reproduzível e versionada — sem depender de
 * comando ad hoc.
 */
import { describe, expect, it } from "vitest"
import { config } from "../config"

describe("config do projeto gerenteagentes", () => {
  it("define a tela tarefas-list como external apontando para a API do motor", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    expect(grupoTarefas).toBeDefined()

    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    expect(tela).toBeDefined()

    const screen = tela!.screen
    expect(screen.kind).toBe("external")
    expect(screen.baseUrl).toBe("http://api.tarefas.localhost")
    expect(screen.method).toBe("GET")
    expect(screen.pathTemplate).toBe("/api/tasks")
    expect(screen.dataPath).toBe("tasks")
  })

  it("define a action iniciar-tarefa com POST /api/task/:id/start", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    const screen = tela!.screen

    expect(screen.actions).toBeDefined()
    const action = screen.actions![0]
    expect(action).toEqual({
      id: "iniciar-tarefa",
      label: "Iniciar tarefa",
      method: "POST",
      path: "/api/task/:id/start",
      confirm: "Deseja iniciar esta tarefa no motor de execução?",
    })
  })
})
