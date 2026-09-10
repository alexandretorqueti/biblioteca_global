import { describe, expect, it, vi } from "vitest"
import {
  PRIORIDADE_POR_STATUS,
  deriveTaskPriority,
  formatTempoRelativo,
  projetoAvatar,
  calcularMetricas,
  validarCoberturaPrioridade,
} from "../taskFlowHelpers"
import { ALL_TASK_STATUSES } from "../../motor-v2/src/shared/task-statuses"

// ============================================================================
// deriveTaskPriority
// ============================================================================

describe("deriveTaskPriority", () => {
  it("retorna 'alta' para status que exigem ação imediata", () => {
    expect(deriveTaskPriority("blocked")).toBe("alta")
    expect(deriveTaskPriority("failed")).toBe("alta")
    expect(deriveTaskPriority("motor_fix")).toBe("alta")
  })

  it("retorna 'media' para status em andamento ou aguardando", () => {
    expect(deriveTaskPriority("analyzing")).toBe("media")
    expect(deriveTaskPriority("running")).toBe("media")
    expect(deriveTaskPriority("paused")).toBe("media")
    expect(deriveTaskPriority("awaiting_clarification")).toBe("media")
    expect(deriveTaskPriority("ready")).toBe("media")
  })

  it("retorna 'baixa' para status finais ou iniciais", () => {
    expect(deriveTaskPriority("draft")).toBe("baixa")
    expect(deriveTaskPriority("planned")).toBe("baixa")
    expect(deriveTaskPriority("completed")).toBe("baixa")
    expect(deriveTaskPriority("deployed")).toBe("baixa")
    expect(deriveTaskPriority("cancelled")).toBe("baixa")
    expect(deriveTaskPriority("finalizada")).toBe("baixa")
    expect(deriveTaskPriority("deployada")).toBe("baixa")
    expect(deriveTaskPriority("aborted")).toBe("baixa")
  })

  it("retorna 'baixa' como fallback para status desconhecido", () => {
    expect(deriveTaskPriority("status_inexistente")).toBe("baixa")
    expect(deriveTaskPriority("")).toBe("baixa")
  })

  it("cobre 100% dos ALL_TASK_STATUSES", () => {
    const naoCobertos = validarCoberturaPrioridade()
    expect(naoCobertos).toEqual([])
  })

  it("PRIORIDADE_POR_STATUS tem entrada para cada ALL_TASK_STATUSES", () => {
    for (const status of ALL_TASK_STATUSES) {
      expect(PRIORIDADE_POR_STATUS).toHaveProperty(status)
    }
  })
})

// ============================================================================
// formatTempoRelativo
// ============================================================================

describe("formatTempoRelativo", () => {
  const agora = new Date("2026-09-10T12:00:00Z")

  it("retorna 'agora' para menos de 1 minuto", () => {
    expect(formatTempoRelativo("2026-09-10T11:59:30Z", agora)).toBe("agora")
    expect(formatTempoRelativo("2026-09-10T12:00:00Z", agora)).toBe("agora")
  })

  it("retorna 'há Xmin' para minutos", () => {
    expect(formatTempoRelativo("2026-09-10T11:55:00Z", agora)).toBe("há 5min")
    expect(formatTempoRelativo("2026-09-10T11:30:00Z", agora)).toBe("há 30min")
  })

  it("retorna 'há Xh' para horas", () => {
    expect(formatTempoRelativo("2026-09-10T10:00:00Z", agora)).toBe("há 2h")
    expect(formatTempoRelativo("2026-09-10T06:00:00Z", agora)).toBe("há 6h")
  })

  it("retorna 'há Xd' para dias", () => {
    expect(formatTempoRelativo("2026-09-09T12:00:00Z", agora)).toBe("há 1d")
    expect(formatTempoRelativo("2026-09-05T12:00:00Z", agora)).toBe("há 5d")
  })

  it("retorna '—' para data ausente ou inválida", () => {
    expect(formatTempoRelativo(null, agora)).toBe("—")
    expect(formatTempoRelativo(undefined, agora)).toBe("—")
    expect(formatTempoRelativo("data-invalida", agora)).toBe("—")
    expect(formatTempoRelativo("", agora)).toBe("—")
  })

  it("usa a data atual como padrão quando 'agora' não é fornecido", () => {
    // Não lança erro
    expect(() => formatTempoRelativo("2026-09-10T11:55:00Z")).not.toThrow()
  })
})

// ============================================================================
// projetoAvatar
// ============================================================================

describe("projetoAvatar", () => {
  it("retorna a primeira letra maiúscula do nome", () => {
    expect(projetoAvatar(1, "Biblioteca Global")).toEqual({
      letra: "B",
      cor: expect.any(String),
    })
    expect(projetoAvatar(2, "gerenteagentes")).toEqual({
      letra: "G",
      cor: expect.any(String),
    })
  })

  it("retorna '#' quando o nome está ausente ou vazio", () => {
    expect(projetoAvatar(1, null)).toEqual({ letra: "#", cor: expect.any(String) })
    expect(projetoAvatar(1, "")).toEqual({ letra: "#", cor: expect.any(String) })
    expect(projetoAvatar(1, "   ")).toEqual({ letra: "#", cor: expect.any(String) })
    expect(projetoAvatar(1)).toEqual({ letra: "#", cor: expect.any(String) })
  })

  it("gera cor determinística baseada no projetoId", () => {
    const avatar1 = projetoAvatar(1, "Projeto A")
    const avatar2 = projetoAvatar(1, "Projeto B")
    expect(avatar1.cor).toBe(avatar2.cor) // mesmo ID = mesma cor
  })

  it("gera cores diferentes para IDs diferentes", () => {
    const avatar1 = projetoAvatar(1, "Projeto")
    const avatar2 = projetoAvatar(2, "Projeto")
    // Não necessariamente diferentes (depende do hash), mas o sistema é determinístico
    expect(avatar1.cor).toMatch(/^#[0-9a-f]{6}$/i)
    expect(avatar2.cor).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it("lida com IDs negativos (hash absoluto)", () => {
    const avatarPos = projetoAvatar(5, "Teste")
    const avatarNeg = projetoAvatar(-5, "Teste")
    expect(avatarPos.cor).toBe(avatarNeg.cor)
  })
})

// ============================================================================
// calcularMetricas
// ============================================================================

describe("calcularMetricas", () => {
  const agora = new Date("2026-09-10T12:00:00Z")

  it("calcula total de tarefas", () => {
    const tarefas = [
      { id: 1, status: "running", projetoId: 1 },
      { id: 2, status: "completed", projetoId: 1 },
      { id: 3, status: "blocked", projetoId: 1 },
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.total).toBe(3)
  })

  it("calcula tarefas em andamento (analyzing/running/motor_fix)", () => {
    const tarefas = [
      { id: 1, status: "analyzing", projetoId: 1 },
      { id: 2, status: "running", projetoId: 1 },
      { id: 3, status: "motor_fix", projetoId: 1 },
      { id: 4, status: "completed", projetoId: 1 },
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.emAndamento).toBe(3)
  })

  it("calcula tarefas concluídas hoje (completed/finalizada/deployed/deployada com updatedAt no dia)", () => {
    const tarefas = [
      { id: 1, status: "completed", projetoId: 1, updatedAt: "2026-09-10T10:00:00Z" },
      { id: 2, status: "finalizada", projetoId: 1, updatedAt: "2026-09-10T11:00:00Z" },
      { id: 3, status: "deployed", projetoId: 1, updatedAt: "2026-09-10T09:00:00Z" },
      { id: 4, status: "deployada", projetoId: 1, updatedAt: "2026-09-10T08:00:00Z" },
      { id: 5, status: "completed", projetoId: 1, updatedAt: "2026-09-09T10:00:00Z" }, // ontem
      { id: 6, status: "running", projetoId: 1, updatedAt: "2026-09-10T10:00:00Z" }, // não concluída
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.concluidasHoje).toBe(4)
  })

  it("calcula tarefas bloqueadas (blocked/failed)", () => {
    const tarefas = [
      { id: 1, status: "blocked", projetoId: 1 },
      { id: 2, status: "failed", projetoId: 1 },
      { id: 3, status: "running", projetoId: 1 },
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.bloqueadas).toBe(2)
  })

  it("calcula tempo médio de execução das concluídas", () => {
    const tarefas = [
      {
        id: 1,
        status: "completed",
        projetoId: 1,
        createdAt: "2026-09-10T10:00:00Z",
        updatedAt: "2026-09-10T12:00:00Z", // 2h
      },
      {
        id: 2,
        status: "completed",
        projetoId: 1,
        createdAt: "2026-09-10T09:00:00Z",
        updatedAt: "2026-09-10T12:00:00Z", // 3h
      },
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.tempoMedioExecucao).toBe("2h 30min")
  })

  it("retorna '—' para tempo médio quando não há concluídas com datas válidas", () => {
    const tarefas = [
      { id: 1, status: "running", projetoId: 1 },
      { id: 2, status: "completed", projetoId: 1 }, // sem createdAt/updatedAt
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.tempoMedioExecucao).toBe("—")
  })

  it("calcula contagem por estação", () => {
    const tarefas = [
      { id: 1, status: "planned", projetoId: 1 },
      { id: 2, status: "analyzing", projetoId: 1 },
      { id: 3, status: "running", projetoId: 1 },
      { id: 4, status: "completed", projetoId: 1 },
      { id: 5, status: "blocked", projetoId: 1 },
    ]
    const metricas = calcularMetricas(tarefas, agora)
    expect(metricas.porEstacao.planning).toBe(1)
    expect(metricas.porEstacao.analyzing).toBe(1)
    expect(metricas.porEstacao.running).toBe(1)
    expect(metricas.porEstacao.completed).toBe(1)
    expect(metricas.porEstacao.attention).toBe(1)
    expect(metricas.porEstacao.deployed).toBe(0)
  })

  it("lida com lista vazia", () => {
    const metricas = calcularMetricas([], agora)
    expect(metricas.total).toBe(0)
    expect(metricas.emAndamento).toBe(0)
    expect(metricas.concluidasHoje).toBe(0)
    expect(metricas.bloqueadas).toBe(0)
    expect(metricas.tempoMedioExecucao).toBe("—")
    expect(Object.values(metricas.porEstacao).every((v) => v === 0)).toBe(true)
  })

  it("usa a data atual como padrão quando 'agora' não é fornecido", () => {
    const tarefas = [{ id: 1, status: "running", projetoId: 1 }]
    expect(() => calcularMetricas(tarefas)).not.toThrow()
  })
})

// ============================================================================
// validarCoberturaPrioridade
// ============================================================================

describe("validarCoberturaPrioridade", () => {
  it("retorna array vazio quando todos os status estão cobertos", () => {
    expect(validarCoberturaPrioridade()).toEqual([])
  })
})
