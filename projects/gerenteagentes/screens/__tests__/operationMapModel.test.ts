// @vitest-environment jsdom
/**
 * Verificadores do modelo do Mapa Vivo da Operação (tarefa 826, subtarefa 1085).
 *
 * Esta suíte é o "verificador" do mapa: cada bloco prova uma invariante da
 * auditoria (docs/AUDITORIA-E-INVARIANTES-MAPA-DE-AGENTES.md) sobre a camada
 * de modelo pura (`operationMapModel.ts`), comparando-a com as fontes
 * canônicas já existentes (status, helpers e catálogo da tela legada).
 *
 * Nenhuma tela é alterada aqui: a equivalência é verificada, não reescrita.
 */
import { describe, expect, it } from "vitest"
import {
  ALL_TASK_STATUSES,
  TASK_STATUS_LABELS,
} from "../../motor-v2/src/shared/task-statuses"
import {
  getEffectiveStatusForMetrics,
  PRIORIDADE_POR_STATUS,
  deriveTaskPriority,
} from "../taskFlowHelpers"
import {
  MAIN_FLOW,
  SIDE_FLOW,
  getEffectiveStatus,
  type FlowTask,
  type FiltrosMapa,
} from "../TaskFlowMap"
import {
  EMPTY_OPERATION_FILTERS,
  OPERATION_ACTIVE_AI_STATUSES,
  OPERATION_DEPLOYED_PREVIEW_LIMIT,
  OPERATION_EXCEPTION_STATIONS,
  OPERATION_FILTER_GROUPS,
  OPERATION_HUMAN_STATUSES,
  OPERATION_MAIN_STATIONS,
  OPERATION_MARKER_LIMIT,
  OPERATION_STATIONS,
  OPERATION_STATION_BY_ID,
  OPERATION_TONE_META,
  buildOperationMapModel,
  describeActiveOperationFilters,
  describeConnection,
  describeTone,
  effectiveOperationStatus,
  filterOperationTasks,
  hasActiveOperationFilters,
  resolveFilterGroupStatuses,
  selectVisibleMarkers,
  sortByRecency,
  stationForStatus,
  stationForTask,
  stationTasks,
  summarizeMetrics,
  summarizeWorkers,
  tasksAwaitingHuman,
  unmappedTasks,
  verificarInvariantesDoModelo,
} from "../operationMapModel"

// ─── Fixtures ────────────────────────────────────────────────────────────────

function tarefa(id: number, status: string, extra: Partial<FlowTask> = {}): FlowTask {
  return {
    id,
    titulo: `Tarefa ${id}`,
    status,
    projetoId: 1,
    subtaskCount: 3,
    ...extra,
  }
}

const t = (status: string, id = 1, extra: Partial<FlowTask> = {}) =>
  tarefa(id, status, extra)

// ============================================================================
// Catálogo de estações (INV-F1, INV-C2, INV-L3)
// ============================================================================

describe("catálogo de estações", () => {
  it("cobre cada status canônico em exatamente uma estação (INV-F1/INV-C2)", () => {
    for (const status of ALL_TASK_STATUSES) {
      const estacoes = OPERATION_STATIONS.filter((station) =>
        station.statuses.includes(status),
      )
      expect(estacoes, `status ${status} deveria estar em 1 estação`).toHaveLength(1)
    }
  })

  it("não referencia status inexistente nem duplica ids", () => {
    const ids = OPERATION_STATIONS.map((station) => station.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const station of OPERATION_STATIONS) {
      for (const status of station.statuses) {
        expect(ALL_TASK_STATUSES).toContain(status)
      }
    }
  })

  it("usa os mesmos rótulos/status/tom de MAIN_FLOW e SIDE_FLOW (INV-L3)", () => {
    const legado = [...MAIN_FLOW, ...SIDE_FLOW]
    expect(OPERATION_STATIONS).toHaveLength(legado.length)
    for (const [index, station] of OPERATION_STATIONS.entries()) {
      const referencia = legado[index]!
      expect(station.id).toBe(referencia.id)
      expect(station.label).toBe(referencia.label)
      expect(station.subtitle).toBe(referencia.subtitle)
      expect(station.statuses).toEqual(referencia.statuses)
      expect(station.tone).toBe(referencia.tone)
    }
  })

  it("separa fluxo principal de exceções (INV-F8)", () => {
    expect(OPERATION_MAIN_STATIONS.map((station) => station.id)).toEqual([
      "draft",
      "planned",
      "analyzing",
      "ready",
      "running",
      "completed",
      "deployed",
    ])
    expect(OPERATION_EXCEPTION_STATIONS.map((station) => station.id)).toEqual([
      "waiting",
      "repair",
      "attention",
      "closed",
    ])
    for (const station of OPERATION_MAIN_STATIONS) {
      expect(station.flow).toBe("main")
    }
    for (const station of OPERATION_EXCEPTION_STATIONS) {
      expect(station.flow).toBe("exception")
    }
  })

  it("rotula os tons sem depender de cor (INV-A2) e sem hex hardcoded (INV-A1)", () => {
    for (const station of OPERATION_STATIONS) {
      const meta = describeTone(station.tone)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.glyph.length).toBeGreaterThan(0)
      expect(meta.colorToken.startsWith("#")).toBe(false)
      expect(OPERATION_TONE_META[station.tone]).toBeDefined()
    }
  })

  it("stationForStatus não conhece status fora do catálogo", () => {
    expect(stationForStatus("running")?.id).toBe("running")
    expect(stationForStatus("ai_gerando_codigo")).toBeUndefined()
  })
})

// ============================================================================
// Status efetivo (INV-F11)
// ============================================================================

describe("status efetivo do mapa (INV-F11)", () => {
  it("paused sem subtarefas é Rascunho em toda a stack", () => {
    const semSubtarefas = tarefa(1, "paused", { subtaskCount: 0 })
    const semContagem = tarefa(2, "paused", { subtaskCount: undefined })
    expect(effectiveOperationStatus(semSubtarefas)).toBe("draft")
    expect(effectiveOperationStatus(semContagem)).toBe("draft")
    expect(getEffectiveStatus(semSubtarefas)).toBe("draft")
    expect(getEffectiveStatusForMetrics(semSubtarefas)).toBe("draft")
    expect(getEffectiveStatusForMetrics(semContagem)).toBe("draft")
  })

  it("paused com subtarefas continua em Aguardando", () => {
    const comSubtarefas = { status: "paused", subtaskCount: 2 }
    expect(effectiveOperationStatus(comSubtarefas)).toBe("paused")
    expect(stationForTask(comSubtarefas).id).toBe("waiting")
    expect(stationForTask({ status: "paused", subtaskCount: 0 }).id).toBe("draft")
    expect(stationForTask({ status: "paused" }).id).toBe("draft")
  })

  it("concorda com as implementações da tela legada e dos helpers", () => {
    const contagens: Array<number | undefined> = [undefined, 0, 1, 5]
    let seq = 0
    for (const status of ALL_TASK_STATUSES) {
      for (const subtaskCount of contagens) {
        const entrada = tarefa(++seq, status, { subtaskCount })
        expect(effectiveOperationStatus(entrada)).toBe(getEffectiveStatus(entrada))
        expect(effectiveOperationStatus(entrada)).toBe(
          getEffectiveStatusForMetrics(entrada),
        )
      }
    }
  })

  it("status desconhecido continua alcançável via Atenção e é reportado", () => {
    const desconhecida = t("status_novo_do_motor", 999)
    const estacao = stationForTask(desconhecida)
    expect(estacao.id).toBe("attention")
    expect(unmappedTasks([desconhecida, t("running", 1)])).toEqual([desconhecida])
  })
})

// ============================================================================
// Filtros (INV-F3, INV-F8, INV-F9)
// ============================================================================

describe("filtros do mapa", () => {
  const tarefas: FlowTask[] = [
    tarefa(819, "running", { titulo: "Limpeza de concluídos", projetoId: 1 }),
    tarefa(820, "analyzing", { titulo: "Análise de escopo", projetoId: 2 }),
    tarefa(821, "awaiting_clarification", { titulo: "Precisa de resposta", projetoId: 1 }),
    tarefa(822, "blocked", { titulo: "Bloqueada na triagem", projetoId: 2 }),
    tarefa(823, "deployed", { titulo: "Já em produção", projetoId: 1 }),
    tarefa(824, "paused", { titulo: "Pausada sem subtarefas", projetoId: 1, subtaskCount: 0 }),
  ]

  const filtrar = (parcial: Partial<FiltrosMapa>) =>
    filterOperationTasks(tarefas, { ...EMPTY_OPERATION_FILTERS, ...parcial })

  it("busca por #id e por título (case-insensitive)", () => {
    expect(filtrar({ busca: "#819" }).map((item) => item.id)).toEqual([819])
    expect(filtrar({ busca: "limpeza" }).map((item) => item.id)).toEqual([819])
    expect(filtrar({ busca: "  PRODUÇÃO " }).map((item) => item.id)).toEqual([823])
    expect(filtrar({ busca: "inexistente" })).toEqual([])
  })

  it("filtra por projeto e por prioridade derivada do status", () => {
    expect(filtrar({ projetoId: 2 }).map((item) => item.id)).toEqual([820, 822])
    expect(filtrar({ prioridade: "alta" }).map((item) => item.id)).toEqual([822])
    expect(filtrar({ prioridade: "media" }).map((item) => item.id)).toEqual([
      819, 820, 821, 824,
    ])
  })

  it("chips de status usam os grupos canônicos (INV-F8)", () => {
    expect(filtrar({ status: ["em-execucao"] }).map((item) => item.id)).toEqual([
      819, 820,
    ])
    expect(filtrar({ status: ["aguardando"] }).map((item) => item.id)).toEqual([821])
    expect(filtrar({ status: ["bloqueadas"] }).map((item) => item.id)).toEqual([822])
    expect(filtrar({ status: ["concluidas"] }).map((item) => item.id)).toEqual([823])
    expect(
      filtrar({ status: ["em-execucao", "bloqueadas"] }).map((item) => item.id),
    ).toEqual([819, 820, 822])
  })

  it("chip 'aguardando' considera o status efetivo: paused sem subtarefas fica fora", () => {
    expect(filtrar({ status: ["aguardando"] }).map((item) => item.id)).toEqual([821])
    expect(filtrar({ status: ["aguardando"] })).not.toContainEqual(
      expect.objectContaining({ id: 824 }),
    )
  })

  it("slugs desconhecidos não escondem nada e a limpeza é reversível", () => {
    expect(resolveFilterGroupStatuses(["nao-existe"])).toEqual([])
    expect(filtrar({ status: ["nao-existe"] })).toHaveLength(tarefas.length)
    expect(filtrar({})).toHaveLength(tarefas.length)
    expect(hasActiveOperationFilters(EMPTY_OPERATION_FILTERS)).toBe(false)
    expect(hasActiveOperationFilters({ ...EMPTY_OPERATION_FILTERS, busca: "x" })).toBe(true)
  })

  it("descreve os filtros ativos em texto legível", () => {
    const chips = describeActiveOperationFilters(
      {
        busca: "limpeza",
        status: ["em-execucao"],
        projetoId: 1,
        prioridade: "media",
      },
      [{ id: 1, nome: "Biblioteca Global" }],
    )
    const labels = chips.map((chip) => chip.label)
    expect(labels).toContain("Busca: limpeza")
    expect(labels).toContain("Status: Em execução")
    expect(labels).toContain("Projeto: Biblioteca Global")
    expect(labels).toContain("Prioridade: media")
    expect(describeActiveOperationFilters(EMPTY_OPERATION_FILTERS)).toEqual([])
  })

  it("todo grupo de filtro referencia apenas status conhecidos", () => {
    for (const group of OPERATION_FILTER_GROUPS) {
      expect(group.statuses.length).toBeGreaterThan(0)
      for (const status of group.statuses) {
        expect(ALL_TASK_STATUSES).toContain(status)
      }
    }
  })
})

// ============================================================================
// Densidade de marcadores (INV-F2, INV-F7)
// ============================================================================

describe("densidade de marcadores", () => {
  const itens = Array.from({ length: 12 }, (_, index) => index)

  it("mostra 5 por padrão e informa quantos ficaram ocultos", () => {
    const densidade = selectVisibleMarkers(itens)
    expect(densidade.visible).toHaveLength(OPERATION_MARKER_LIMIT)
    expect(densidade.total).toBe(12)
    expect(densidade.hidden).toBe(12 - OPERATION_MARKER_LIMIT)
    expect(densidade.hasMore).toBe(true)
  })

  it("expande para todas sem perder o total (acesso preservado)", () => {
    const densidade = selectVisibleMarkers(itens, { expanded: true })
    expect(densidade.visible).toHaveLength(12)
    expect(densidade.hidden).toBe(0)
    expect(densidade.hasMore).toBe(false)
    expect(densidade.total).toBe(12)
  })

  it("respeita limite customizado e listas curtas", () => {
    expect(selectVisibleMarkers(itens, { limit: 3 }).visible).toEqual([0, 1, 2])
    expect(selectVisibleMarkers([1, 2]).hasMore).toBe(false)
    expect(selectVisibleMarkers(itens, { limit: 0 }).visible).toHaveLength(1)
    expect(selectVisibleMarkers([], {}).total).toBe(0)
  })

  it("ordena por recência e limita a prévia de deployadas (INV-F7)", () => {
    const deployadas: FlowTask[] = [
      tarefa(1, "deployed", { updatedAt: "2026-09-10T10:00:00.000Z" }),
      tarefa(2, "deployed", { updatedAt: "2026-09-12T10:00:00.000Z" }),
      tarefa(3, "deployed", { updatedAt: "2026-09-11T10:00:00.000Z" }),
      tarefa(4, "deployed", { updatedAt: "2026-09-09T10:00:00.000Z" }),
    ]
    expect(sortByRecency(deployadas).map((item) => item.id)).toEqual([2, 3, 1, 4])
    const previa = selectVisibleMarkers(sortByRecency(deployadas), {
      limit: OPERATION_DEPLOYED_PREVIEW_LIMIT,
    })
    expect(previa.visible.map((item) => item.id)).toEqual([2, 3, 1])
    expect(previa.total).toBe(4)
    expect(previa.hidden).toBe(1)
  })

  it("datas inválidas ou ausentes não quebram a ordenação", () => {
    const semData = [tarefa(1, "deployed"), tarefa(2, "deployed", { updatedAt: "data-invalida" })]
    expect(sortByRecency(semData)).toHaveLength(2)
  })
})

// ============================================================================
// Intervenção humana (INV-F9)
// ============================================================================

describe("intervenção humana", () => {
  it("conta apenas awaiting_clarification", () => {
    const tarefas = [
      t("awaiting_clarification", 1),
      t("paused", 2, { subtaskCount: 2 }),
      t("paused", 3, { subtaskCount: 0 }),
      t("running", 4),
    ]
    expect(tasksAwaitingHuman(tarefas).map((item) => item.id)).toEqual([1])
    expect(OPERATION_HUMAN_STATUSES.has("awaiting_clarification")).toBe(true)
  })
})

// ============================================================================
// Workers (operação viva)
// ============================================================================

describe("resumo de workers", () => {
  const payload = {
    activeWorkers: 3,
    maxWorkers: 4,
    workers: [
      { executionId: "e1", taskId: "task-p1-804", phase: "verify", projectSlug: "gerenteagentes", ageMs: 1200 },
      { executionId: "e2", taskId: "task-p1-805", phase: "execute", subtaskId: 1085, ageMs: 900 },
      { executionId: "e3", taskId: "task-p1-804", phase: "deploy", ageMs: 300 },
    ],
    activities: [{ taskId: "task-p1-804", phase: "verify" }],
  }

  it("normaliza o payload de /motor/stats e deduplica tarefas ativas", () => {
    const resumo = summarizeWorkers(payload)
    expect(resumo.activeWorkers).toBe(3)
    expect(resumo.maxWorkers).toBe(4)
    expect(resumo.busy).toBe(true)
    expect(resumo.workers).toHaveLength(3)
    expect(resumo.workers.every((worker) => worker.busy)).toBe(true)
    expect(resumo.workers[1]?.subtaskId).toBe(1085)
    expect(resumo.executingTaskIds).toEqual(["task-p1-804", "task-p1-805"])
  })

  it("tolera payload ausente, inválido ou parcial (não quebra o mapa)", () => {
    for (const entrada of [undefined, null, "texto", 42, [], {}] as unknown[]) {
      const resumo = summarizeWorkers(entrada)
      expect(resumo.activeWorkers).toBe(0)
      expect(resumo.maxWorkers).toBeNull()
      expect(resumo.workers).toEqual([])
      expect(resumo.busy).toBe(false)
    }
    const parcial = summarizeWorkers({ workers: [{ taskId: "x" }, { semTaskId: true }, null] })
    expect(parcial.workers.map((worker) => worker.taskId)).toEqual(["x"])
    expect(parcial.activeWorkers).toBe(1)
  })
})

// ============================================================================
// Tempo real (INV-F10)
// ============================================================================

describe("estado da conexão em tempo real", () => {
  it("rotula conectado, conectando e reconectando com tom e aria-label", () => {
    expect(describeConnection("open").label).toBe("Tempo real conectado")
    expect(describeConnection("open").tone).toBe("success")
    expect(describeConnection("connecting").label).toBe("Conectando…")
    expect(describeConnection("connecting").tone).toBe("warning")
    expect(describeConnection("closed").label).toBe("Reconectando…")
    expect(describeConnection("closed").ariaLabel.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// Métricas e modelo completo (INV-F10, INV-A6)
// ============================================================================

describe("métricas do topo", () => {
  const tarefas: FlowTask[] = [
    t("draft", 1, { subtaskCount: 0 }),
    t("planned", 2),
    t("analyzing", 3),
    t("running", 4),
    t("running", 5),
    t("awaiting_clarification", 6),
    t("motor_fix", 7),
    t("blocked", 8),
    t("failed", 9),
    t("completed", 10),
    t("deployed", 11),
    t("deployed", 12),
    t("cancelled", 13),
  ]

  it("conta execução, bloqueios, entregas e deployadas de forma coerente", () => {
    const workers = summarizeWorkers({ activeWorkers: 2, workers: [] })
    const metricas = summarizeMetrics(tarefas, tarefas, workers, new Date("2026-09-13T12:00:00.000Z"))
    expect(metricas.total).toBe(13)
    expect(metricas.filtered).toBe(13)
    expect(metricas.executing).toBe(4) // analyzing + 2 running + motor_fix
    expect(metricas.blocked).toBe(2)
    expect(metricas.delivered).toBe(3) // completed + 2 deployed
    expect(metricas.deployed).toBe(2)
    expect(metricas.awaitingHuman).toBe(1)
    expect(metricas.workers.activeWorkers).toBe(2)
  })

  it("as chaves de porEstação são exatamente as estações do catálogo", () => {
    const metricas = summarizeMetrics(tarefas, tarefas, summarizeWorkers(null))
    expect(Object.keys(metricas.byStation).sort()).toEqual(
      OPERATION_STATIONS.map((station) => station.id).sort(),
    )
    // mesma estrutura usada pela tela legada (MetricasMapa.porEstacao)
    expect(metricas.byStation.running).toBe(2)
    expect(metricas.byStation.deployed).toBe(2)
  })
})

describe("buildOperationMapModel", () => {
  const tarefas: FlowTask[] = [
    t("running", 1),
    t("running", 2),
    t("running", 3),
    t("running", 4),
    t("running", 5),
    t("running", 6),
    t("awaiting_clarification", 7),
    t("blocked", 8),
    t("deployed", 9, { updatedAt: "2026-09-13T09:00:00.000Z" }),
    t("deployed", 10, { updatedAt: "2026-09-12T09:00:00.000Z" }),
    t("paused", 11, { subtaskCount: 0 }),
  ]

  it("distribui as tarefas nas estações com total e filtrado distintos", () => {
    const modelo = buildOperationMapModel({ tarefas })
    const running = modelo.stations.find((view) => view.station.id === "running")
    expect(running?.total).toBe(6)
    expect(running?.filteredTotal).toBe(6)
    expect(running?.markers).toHaveLength(OPERATION_MARKER_LIMIT)
    expect(running?.hiddenCount).toBe(1)
    expect(running?.hasMore).toBe(true)
    expect(running?.active).toBe(true)

    const draft = modelo.stations.find((view) => view.station.id === "draft")
    expect(draft?.total).toBe(1) // paused sem subtarefas

    const filtrado = buildOperationMapModel({ tarefas, filtros: { ...EMPTY_OPERATION_FILTERS, projetoId: 99 } })
    const runningFiltrado = filtrado.stations.find((view) => view.station.id === "running")
    expect(runningFiltrado?.total).toBe(6)
    expect(runningFiltrado?.filteredTotal).toBe(0)
  })

  it("expande uma estação sem esconder o total (INV-F2)", () => {
    const modelo = buildOperationMapModel({ tarefas, expandedStations: ["running"] })
    const running = modelo.stations.find((view) => view.station.id === "running")
    expect(running?.markers).toHaveLength(6)
    expect(running?.hiddenCount).toBe(0)
    expect(running?.expanded).toBe(true)
    expect(running?.total).toBe(6)
  })

  it("resume exceções e intervenção humana (INV-F8/INV-F9)", () => {
    const modelo = buildOperationMapModel({ tarefas })
    expect(modelo.exceptions.byStation.waiting).toBe(1) // awaiting_clarification
    expect(modelo.exceptions.byStation.attention).toBe(1)
    expect(modelo.exceptions.total).toBe(2)
    expect(modelo.exceptions.hasAny).toBe(true)
    expect(modelo.exceptions.needsHuman).toBe(2)
    expect(modelo.awaitingHuman.map((item) => item.id)).toEqual([7])

    const vazio = buildOperationMapModel({ tarefas: [t("running", 1)] })
    expect(vazio.exceptions.total).toBe(0)
    expect(vazio.exceptions.hasAny).toBe(false)
  })

  it("entrega a prévia do terminal de produção com acesso ao total (INV-F7)", () => {
    const modelo = buildOperationMapModel({ tarefas })
    expect(modelo.deployedPreview.visible.map((item) => item.id)).toEqual([9, 10])
    expect(modelo.deployedPreview.total).toBe(2)
  })

  it("expõe filtros ativos, atividades e workers sem alterar a entrada", () => {
    const copia = JSON.parse(JSON.stringify(tarefas)) as FlowTask[]
    const modelo = buildOperationMapModel({
      tarefas,
      atividades: [{ taskId: "task-p1-804", phase: "verify" }],
      stats: { activeWorkers: 1, workers: [{ taskId: "task-p1-804" }] },
      filtros: { ...EMPTY_OPERATION_FILTERS, busca: "Tarefa 1" },
      projetos: [{ id: 1, nome: "GerenteAgentes" }],
    })
    expect(modelo.hasActiveFilters).toBe(true)
    expect(modelo.activeFilters.map((chip) => chip.label)).toEqual(["Busca: Tarefa 1"])
    expect(modelo.activities).toHaveLength(1)
    expect(modelo.activeTaskIds).toEqual(["task-p1-804"])
    expect(modelo.metrics.workers.activeWorkers).toBe(1)
    expect(tarefas).toEqual(copia) // entrada intacta
  })

  it("é determinístico e não lança com entrada vazia", () => {
    const agora = new Date("2026-09-13T12:00:00.000Z")
    const entrada = { tarefas, agora }
    expect(buildOperationMapModel(entrada)).toEqual(buildOperationMapModel(entrada))
    const vazio = buildOperationMapModel({ tarefas: [], agora })
    expect(vazio.metrics.total).toBe(0)
    expect(vazio.filtered).toEqual([])
    expect(vazio.deployedPreview.total).toBe(0)
    expect(vazio.unmapped).toEqual([])
    expect(vazio.stations.every((view) => view.total === 0)).toBe(true)
  })

  it("tarefas legadas caem nas estações corretas (compatibilidade v1)", () => {
    const modelo = buildOperationMapModel({
      tarefas: [t("finalizada", 1), t("deployada", 2), t("aborted", 3)],
    })
    const porId = Object.fromEntries(
      modelo.stations.map((view) => [view.station.id, view.total]),
    )
    expect(porId.completed).toBe(1)
    expect(porId.deployed).toBe(1)
    expect(porId.closed).toBe(1)
    expect(modelo.unmapped).toEqual([])
  })
})

// ============================================================================
// Verificador global + cobertura de status
// ============================================================================

describe("verificarInvariantesDoModelo", () => {
  it("não encontra violações no modelo atual", () => {
    expect(verificarInvariantesDoModelo()).toEqual([])
  })

  it("mantém o fallback de 'Atenção' disponível para status desconhecidos", () => {
    expect(OPERATION_STATION_BY_ID.attention).toBeDefined()
    expect(OPERATION_STATIONS.some((station) => station.id === "attention")).toBe(true)
  })
})

describe("cobertura de status e classificação (INV-C2)", () => {
  it("cada status canônico tem rótulo (fonte única, sem duplicar labels)", () => {
    for (const status of ALL_TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[status]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it("prioridade continua vindo do helper canônico", () => {
    for (const status of ALL_TASK_STATUSES) {
      expect(deriveTaskPriority(status)).toBe(PRIORIDADE_POR_STATUS[status])
    }
  })

  it("os status 'ativos de IA' batem com a estação ativa do fluxo", () => {
    for (const status of OPERATION_ACTIVE_AI_STATUSES) {
      const estacao = stationForStatus(status)
      expect(estacao?.tone).toBe("active")
    }
    expect(stationTasks([t("running", 1), t("blocked", 2)], OPERATION_STATION_BY_ID.running!)).toHaveLength(1)
  })
})
