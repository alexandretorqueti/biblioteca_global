// @vitest-environment node
/**
 * Valida a configuração do projeto `gerenteagentes` — em especial a tela
 * "Tarefas" (kind: cadastro, resource: tarefas) que consome a API interna da
 * plataforma (/api/gerenteagentes/tarefas) e as ações de start/pause/resume.
 *
 * Histórico: esta tela já foi validada quando era `kind: "external"` apontando
 * para a API do motor (http://api.tarefas.localhost/api/tasks). O commit
 * ddd99a2 a converteu para `kind: "cadastro"` contra a API interna da
 * plataforma. Este teste valida o contrato ATUAL (cadastro + ações), de forma
 * reproduzível e versionada sob Vitest (transpila TS; `projects/*` é CJS).
 */
import { describe, expect, it } from "vitest"
import { config } from "../config"

describe("config do projeto gerenteagentes", () => {
  it("define a tela tarefas-list como cadastro apontando para o resource tarefas", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    expect(grupoTarefas).toBeDefined()

    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    expect(tela).toBeDefined()

    const screen = tela!.screen
    expect(screen.kind).toBe("cadastro")
    expect(screen.resource).toBe("tarefas")
    expect(screen.title).toBe("Tarefas")
  })

  it("define as actions iniciar/pausar/retomar com POST para a API interna", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    const screen = tela!.screen

    expect(screen.actions).toBeDefined()
    expect(screen.actions!.length).toBe(3)

    const iniciar = screen.actions!.find((a) => a.id === "iniciar-tarefa")
    expect(iniciar).toEqual({
      id: "iniciar-tarefa",
      label: "Iniciar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/start",
      confirm: "Iniciar execução desta tarefa?",
    })

    const pausar = screen.actions!.find((a) => a.id === "pausar-tarefa")
    expect(pausar).toEqual({
      id: "pausar-tarefa",
      label: "Pausar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/pause",
      confirm: "Pausar esta tarefa?",
    })

    const retomar = screen.actions!.find((a) => a.id === "retomar-tarefa")
    expect(retomar).toEqual({
      id: "retomar-tarefa",
      label: "Retomar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/resume",
      confirm: "Retomar execução desta tarefa?",
    })
  })

  it("define os campos obrigatórios da tela tarefas-list", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    const screen = tela!.screen

    const fields = screen.fields
    expect(fields).toBeDefined()

    const obrigatórios = fields!.filter((f) => f.required).map((f) => f.name)
    expect(obrigatórios).toEqual(["projetoId", "agenteId", "titulo"])

    const titulo = fields!.find((f) => f.name === "titulo")
    expect(titulo).toBeDefined()
    expect(titulo!.label).toBe("Título")
    expect(titulo!.type).toBe("text")
    expect(titulo!.fullWidth).toBe(true)

    const descricao = fields!.find((f) => f.name === "descricao")
    expect(descricao).toBeDefined()
    expect(descricao!.type).toBe("textarea")
  })

  it("define o status como select com os valores do motor", () => {
    const grupoTarefas = config.groups.find((g) => g.id === "tarefas")
    const tela = grupoTarefas!.items.find((i) => i.id === "tarefas-list")
    const screen = tela!.screen

    const status = screen.fields!.find((f) => f.name === "status")
    expect(status).toBeDefined()
    expect(status!.type).toBe("select")

    const valores = status!.options!.map((o) => o.value)
    expect(valores).toEqual([
      "draft",
      "planned",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ])
  })
})
