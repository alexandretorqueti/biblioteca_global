// @vitest-environment node
/**
 * Valida a configuração do projeto `gerenteagentes` — em especial a tela
 * "Tarefas" (kind: cadastro, resource: tarefas) que consome a API interna da
 * plataforma (/api/gerenteagentes/tarefas) e as ações de start/pause/resume.
 *
 * Histórico: esta tela já foi validada quando era `kind: "external"` apontando
 * para a API do motor (http://api.tarefas.localhost/api/tasks). O commit
 * ddd99a2 a converteu para `kind: "cadastro"` contra a API interna da
 * plataforma. Com a navegação hierárquica (2026-08-18), a tela "Tarefas" virou
 * uma childRoute do item "Projetos" — este teste valida o contrato ATUAL
 * (childRoutes + cadastro + rowActions), de forma reproduzível e versionada
 * sob Vitest.
 */
import { describe, expect, it } from "vitest"
import {
  config,
} from "../config"
import type {
  CadastroScreenConfig,
  ChildRoute,
} from "@biblioteca-global/shared"

/** Localiza a ChildRoute "tarefas" do item "Projetos". */
function localizarTelaTarefas(): CadastroScreenConfig {
  const grupoProjetos = config.groups.find((g) => g.id === "projetos")
  expect(grupoProjetos, "grupo projetos deve existir").toBeDefined()

  const item = grupoProjetos!.items.find((i) => i.id === "projetos-list")
  expect(item, "item projetos-list deve existir").toBeDefined()

  expect(item!.screen.kind).toBe("cadastro")
  const screen = item!.screen as CadastroScreenConfig

  const rota = (screen.childRoutes ?? []).find((r) => r.id === "tarefas")
  expect(rota, "childRoute tarefas deve existir").toBeDefined()

  const tela = (rota as ChildRoute)
  expect(tela.targetResource).toBe("tarefas")
  return tela as unknown as CadastroScreenConfig
}

describe("config do projeto gerenteagentes", () => {
  it("define limites locais para o formulário de projetos", () => {
    const grupo = config.groups.find((g) => g.id === "projetos")!
    const tela = grupo.items.find((i) => i.id === "projetos-list")!.screen as CadastroScreenConfig
    const nome = tela.fields!.find((field) => field.name === "nome")!
    const slug = tela.fields!.find((field) => field.name === "slug")!

    expect(nome).toMatchObject({ required: true, maxLength: 200 })
    expect(slug).toMatchObject({ required: true, minLength: 2, maxLength: 100 })
  })

  it("define a tela tarefas como cadastro apontando para o resource tarefas", () => {
    const tela = localizarTelaTarefas() as unknown as ChildRoute

    expect(tela.targetResource).toBe("tarefas")
    expect(tela.title).toBe("Tarefas do Projeto")
  })

  it("define as rowActions iniciar/pausar/retomar com POST para a API interna", () => {
    const tela = localizarTelaTarefas() as unknown as ChildRoute

    expect(tela.rowActions).toBeDefined()
    expect(tela.rowActions!.length).toBe(3)

    const iniciar = tela.rowActions!.find((a) => a.id === "iniciar-tarefa")
    expect(iniciar).toEqual({
      id: "iniciar-tarefa",
      label: "Iniciar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/start",
      confirm: "Iniciar execução desta tarefa?",
    })

    const pausar = tela.rowActions!.find((a) => a.id === "pausar-tarefa")
    expect(pausar).toEqual({
      id: "pausar-tarefa",
      label: "Pausar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/pause",
      confirm: "Pausar esta tarefa?",
    })

    const retomar = tela.rowActions!.find((a) => a.id === "retomar-tarefa")
    expect(retomar).toEqual({
      id: "retomar-tarefa",
      label: "Retomar",
      method: "POST",
      path: "/api/gerenteagentes/tarefas/:id/resume",
      confirm: "Retomar execução desta tarefa?",
    })
  })

  it("define os campos obrigatórios da tela tarefas", () => {
    const tela = localizarTelaTarefas() as unknown as ChildRoute

    const fields = tela.fields
    expect(fields).toBeDefined()

    const obrigatórios = fields!.filter((f) => f.required).map((f) => f.name)
    // projetoId NÃO é campo de formulário: vem do filtro automático da childRoute.
    // agenteId migrou para projetos_captados (migration 0003) — o motor resolve
    // o agente via tarefa.projetoId → projeto.agenteId.
    expect(obrigatórios).toEqual(["titulo"])

    const titulo = fields!.find((f) => f.name === "titulo")
    expect(titulo).toBeDefined()
    expect(titulo!.label).toBe("Título")
    expect(titulo!.type).toBe("text")
    expect(titulo!.fullWidth).toBe(true)

    const descricao = fields!.find((f) => f.name === "descricao")
    expect(descricao).toBeDefined()
    expect(descricao!.type).toBe("textarea")
  })

  it("define repoPath editável no formulário de projetos", () => {
    const grupoProjetos = config.groups.find((g) => g.id === "projetos")!
    const item = grupoProjetos.items.find((i) => i.id === "projetos-list")!
    const screen = item.screen as CadastroScreenConfig

    const campo = screen.fields!.find((f) => f.name === "repoPath")
    expect(campo).toMatchObject({
      label: "Caminho do repositório",
      type: "text",
      maxLength: 500,
      gridVisible: false,
      fullWidth: true,
    })
  })

  it("define as childRoutes das tarefas (subtarefas, chats, bloqueios)", () => {
    const grupoProjetos = config.groups.find((g) => g.id === "projetos")!
    const item = grupoProjetos.items.find((i) => i.id === "projetos-list")!
    const screen = item.screen as CadastroScreenConfig

    const rotaTarefas = (screen.childRoutes ?? []).find((r) => r.id === "tarefas")
    expect(rotaTarefas).toBeDefined()

    const ids = (rotaTarefas as ChildRoute).childRoutes?.map((r) => r.id) ?? []
    expect(ids).toEqual(["subtarefas", "tarefa-chats", "bloqueios"])
  })

  it("exponha branchTrabalho no formulário de projetos (st-3)", () => {
    const grupo = config.groups.find((g) => g.id === "projetos")!
    const tela = grupo.items.find((i) => i.id === "projetos-list")!.screen as CadastroScreenConfig

    const campo = tela.fields!.find((f) => f.name === "branchTrabalho")
    expect(campo).toBeDefined()
    expect(campo!.label).toBe("Branch de Trabalho")
    expect(campo!.type).toBe("text")
    expect(campo!.maxLength).toBe(255)
    expect(campo!.gridVisible).toBe(false)
  })
})
