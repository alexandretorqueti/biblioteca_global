// @vitest-environment node
/**
 * Unit tests da máquina de estados da tarefa (ciclo de vida — delegação
 * em cadeia, devolução em 3 estados, histórico e chat).
 *
 * Cobrem: arestas válidas (efeito + tipoEvento + de/para), arestas
 * inválidas (erro citando status atual + ação), pré-condições (mensagem
 * da devolução, responsável único/ativo/mesma organização) e a trilha
 * append-only de histórico (cronológica, por tarefa).
 */
import { describe, expect, it } from "vitest"
import {
  acoesPermitidas,
  acaoValida,
  STATUS_TERMINAIS,
  transicionar,
  validarResponsavelAlvo,
  type StatusTarefa,
} from "../maquina-estados"
import {
  eventosDaTarefa,
  historicoCronologico,
  registrarEvento,
  type AcaoFluxo,
  type ColaboradorDestino,
  type EventoHistorico,
  type RegistroHistorico,
  type TarefaFluxo,
  type TransicaoResultado,
} from "../historico"

const AGORA = "2026-11-24T12:00:00.000Z"
const AGORA_1 = "2026-11-24T11:00:00.000Z"
const AGORA_2 = "2026-11-24T12:30:00.000Z"

function tarefa(
  overrides: Partial<TarefaFluxo> = {},
): TarefaFluxo {
  return {
    id: 100,
    organizacaoId: 3,
    responsavelId: 7,
    status: "aberta",
    ...overrides,
  }
}

function colaborador(
  overrides: Partial<ColaboradorDestino> = {},
): ColaboradorDestino {
  return {
    id: 9,
    organizacaoId: 3,
    ativo: true,
    ...overrides,
  }
}

function trans(t: TarefaFluxo, acao: AcaoFluxo, extra: {
  responsavelAlvo?: ColaboradorDestino
  mensagem?: string
  agora?: string | Date
} = {}): TransicaoResultado {
  return transicionar({
    tarefa: t,
    acao,
    responsavelAlvo: extra.responsavelAlvo,
    mensagem: extra.mensagem,
    agora: extra.agora ?? AGORA,
  })
}

describe("arestas válidas", () => {
  it("aberta → delegada (delegar): delegacao, de/atual para/alvo, troca responsavelId", () => {
    const r = trans(tarefa({ status: "aberta", responsavelId: 7 }), "delegar", {
      responsavelAlvo: colaborador({ id: 9 }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("delegada")
    expect(r.efeito.responsavelId).toBe(9)
    expect(r.efeito.concluidaEm).toBeNull()
    expect(r.evento.tipoEvento).toBe("delegacao")
    expect(r.evento.deColaboradorId).toBe(7)
    expect(r.evento.paraColaboradorId).toBe(9)
  })

  it("delegada → concluida (devolver_concluida): preenche concluidaEm, para=null", () => {
    const r = trans(tarefa({ status: "delegada" }), "devolver_concluida", {
      mensagem: "Tudo entregue.",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("concluida")
    expect(r.efeito.concluidaEm).toBe(AGORA)
    expect(r.efeito.responsavelId).toBe(7) // responsável único não muda
    expect(r.evento.tipoEvento).toBe("devolucao_concluida")
    expect(r.evento.deColaboradorId).toBe(7)
    expect(r.evento.paraColaboradorId).toBeNull()
    expect(r.evento.mensagem).toBe("Tudo entregue.")
  })

  it("delegada → precisa_informacoes: apenas status (sem concluidaEm)", () => {
    const r = trans(tarefa({ status: "delegada" }), "devolver_precisa_informacoes", {
      mensagem: "Falta o contrato assinado.",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("precisa_informacoes")
    expect(r.efeito.concluidaEm).toBeNull()
    expect(r.evento.tipoEvento).toBe("devolucao_precisa_info")
    expect(r.evento.deColaboradorId).toBe(7)
    expect(r.evento.paraColaboradorId).toBeNull()
  })

  it("delegada → aguardando_terceiro: apenas status (sem concluidaEm)", () => {
    const r = trans(tarefa({ status: "delegada" }), "devolver_aguardando_terceiro", {
      mensagem: "Aguardando o fornecedor.",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("aguardando_terceiro")
    expect(r.efeito.concluidaEm).toBeNull()
    expect(r.evento.tipoEvento).toBe("devolucao_aguardando_terceiro")
  })

  it("precisa_informacoes → delegada (re-delegação em cadeia): reatribuicao", () => {
    const r = trans(tarefa({ status: "precisa_informacoes", responsavelId: 9 }), "delegar", {
      responsavelAlvo: colaborador({ id: 12 }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("delegada")
    expect(r.efeito.responsavelId).toBe(12)
    expect(r.evento.tipoEvento).toBe("reatribuicao")
    expect(r.evento.deColaboradorId).toBe(9)
    expect(r.evento.paraColaboradorId).toBe(12)
  })

  it("aguardando_terceiro → delegada (re-delegação em cadeia): reatribuicao", () => {
    const r = trans(tarefa({ status: "aguardando_terceiro", responsavelId: 9 }), "delegar", {
      responsavelAlvo: colaborador({ id: 15 }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("delegada")
    expect(r.evento.tipoEvento).toBe("reatribuicao")
    expect(r.evento.paraColaboradorId).toBe(15)
  })

  it("delegada → delegada (re-delegação direta): reatribuicao", () => {
    const r = trans(tarefa({ status: "delegada", responsavelId: 9 }), "delegar", {
      responsavelAlvo: colaborador({ id: 11 }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("delegada")
    expect(r.evento.tipoEvento).toBe("reatribuicao")
  })

  it("aberta → cancelada: mudanca_status, sem de/para colaborador", () => {
    const r = trans(tarefa({ status: "aberta" }), "cancelar")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("cancelada")
    expect(r.efeito.concluidaEm).toBeNull()
    expect(r.evento.tipoEvento).toBe("mudanca_status")
    expect(r.evento.deColaboradorId).toBeNull()
    expect(r.evento.paraColaboradorId).toBeNull()
  })

  it("delegada → cancelada: mudanca_status", () => {
    const r = trans(tarefa({ status: "delegada" }), "cancelar", {
      mensagem: "Tarefa duplicada.",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("cancelada")
    expect(r.evento.tipoEvento).toBe("mudanca_status")
    expect(r.evento.mensagem).toContain("duplicada")
  })

  it("precisa_informacoes → cancelada: mudanca_status", () => {
    const r = trans(tarefa({ status: "precisa_informacoes" }), "cancelar")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("cancelada")
    expect(r.evento.tipoEvento).toBe("mudanca_status")
  })

  it("aguardando_terceiro → cancelada: mudanca_status", () => {
    const r = trans(tarefa({ status: "aguardando_terceiro" }), "cancelar")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.status).toBe("cancelada")
    expect(r.evento.tipoEvento).toBe("mudanca_status")
  })

  it("aceita Date como `agora` (concluidaEm preserva o valor)", () => {
    const d = new Date(AGORA)
    const r = trans(tarefa({ status: "delegada" }), "devolver_concluida", {
      mensagem: "ok",
      agora: d,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.efeito.concluidaEm).toBe(d)
  })
})

describe("arestas inválidas (erro cita status atual + ação)", () => {
  const casosInvalidos: Array<[StatusTarefa, AcaoFluxo]> = [
    // devolução só existe pós-delegação
    ["aberta", "devolver_concluida"],
    ["aberta", "devolver_precisa_informacoes"],
    ["aberta", "devolver_aguardando_terceiro"],
    // terminais sem transição de saída
    ["concluida", "delegar"],
    ["concluida", "cancelar"],
    ["concluida", "devolver_concluida"],
    ["concluida", "devolver_precisa_informacoes"],
    ["concluida", "devolver_aguardando_terceiro"],
    ["cancelada", "delegar"],
    ["cancelada", "cancelar"],
    ["cancelada", "devolver_concluida"],
    ["cancelada", "devolver_precisa_informacoes"],
    ["cancelada", "devolver_aguardando_terceiro"],
  ]

  for (const [status, acao] of casosInvalidos) {
    it(`${status} + ${acao} → rejeitado`, () => {
      const r = trans(
        tarefa({ status, responsavelId: 7 }),
        acao,
        { responsavelAlvo: colaborador({ id: 9 }), mensagem: "motivo qualquer" },
      )
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.erro.statusAtual).toBe(status)
      expect(r.erro.acao).toBe(acao)
      expect(r.erro.motivo).toContain(status)
      expect(r.erro.motivo).toContain(acao)
    })
  }

  it("estado terminal declara 'não aceita a ação' (mensagem específica)", () => {
    const r = trans(tarefa({ status: "concluida" }), "delegar", {
      responsavelAlvo: colaborador(),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("terminal")
  })

  it("estado não-terminal lista as ações permitidas no erro", () => {
    const r = trans(tarefa({ status: "aberta" }), "devolver_concluida", {
      mensagem: "x",
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("delegar")
    expect(r.erro.motivo).toContain("cancelar")
  })
})

describe("pré-condições", () => {
  it("devolução sem mensagem é rejeitada (3 sabores)", () => {
    for (const acao of [
      "devolver_concluida",
      "devolver_precisa_informacoes",
      "devolver_aguardando_terceiro",
    ] as const) {
      const r = trans(tarefa({ status: "delegada" }), acao, { mensagem: "   " })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.erro.motivo).toContain("mensagem")
      expect(r.erro.statusAtual).toBe("delegada")
      expect(r.erro.acao).toBe(acao)
    }
  })

  it("delegação para o responsável atual é rejeitada", () => {
    const r = trans(tarefa({ status: "delegada", responsavelId: 9 }), "delegar", {
      responsavelAlvo: colaborador({ id: 9 }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("diferente do responsável atual")
  })

  it("delegação para colaborador inativo é rejeitada", () => {
    const r = trans(tarefa({ status: "aberta" }), "delegar", {
      responsavelAlvo: colaborador({ ativo: false }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("ativo")
  })

  it("delegação para colaborador de outra organização é rejeitada", () => {
    const r = trans(tarefa({ status: "aberta", organizacaoId: 3 }), "delegar", {
      responsavelAlvo: colaborador({ organizacaoId: 8 }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("mesma organização")
  })

  it("delegação sem responsável-alvo é rejeitada (responsável único)", () => {
    const r = trans(tarefa({ status: "aberta" }), "delegar")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.motivo).toContain("responsável único")
  })

  it("validarResponsavelAlvo isolado: alvo válido passa", () => {
    expect(
      validarResponsavelAlvo(tarefa({ status: "delegada" }), colaborador(), "delegar"),
    ).toEqual({ ok: true })
  })
})

describe("tabela de transições (consultas puras)", () => {
  it("concluida e cancelada são terminais (sem ações permitidas)", () => {
    expect(STATUS_TERMINAIS).toEqual(["concluida", "cancelada"])
    expect(acoesPermitidas("concluida")).toEqual([])
    expect(acoesPermitidas("cancelada")).toEqual([])
  })

  it("aberta: delegar/cancelar", () => {
    expect(acaoValida("aberta", "delegar")).toBe(true)
    expect(acaoValida("aberta", "cancelar")).toBe(true)
    expect(acaoValida("aberta", "devolver_concluida")).toBe(false)
  })

  it("delegada: 5 ações; precisa_informacoes/aguardando_terceiro: delegar/cancelar/3 devoluções", () => {
    expect(acoesPermitidas("delegada")).toEqual([
      "delegar",
      "cancelar",
      "devolver_concluida",
      "devolver_precisa_informacoes",
      "devolver_aguardando_terceiro",
    ])
    expect(acoesPermitidas("precisa_informacoes")).toEqual(acoesPermitidas("delegada"))
    expect(acoesPermitidas("aguardando_terceiro")).toEqual(acoesPermitidas("delegada"))
  })
})

describe("trilha de histórico (append-only, cronológica)", () => {
  function reg(
    partial: Partial<RegistroHistorico> & { id: number; tarefaId: number; criadoEm: string | Date },
    evento?: Partial<EventoHistorico>,
  ): RegistroHistorico {
    return {
      tipoEvento: "mudanca_status",
      deColaboradorId: null,
      paraColaboradorId: null,
      mensagem: null,
      ...evento,
      ...partial,
    }
  }

  it("registrarEvento só ADICIONA: registros anteriores são imutáveis", () => {
    const primeiro = reg({ id: 1, tarefaId: 100, criadoEm: AGORA_1, tipoEvento: "delegacao" })
    const trilha0: RegistroHistorico[] = [primeiro]
    const trilha1 = registrarEvento(trilha0, {
      tipoEvento: "devolucao_concluida",
      deColaboradorId: 9,
      paraColaboradorId: null,
      mensagem: "ok",
    }, { tarefaId: 100, novoId: 2, agora: AGORA })

    expect(trilha1).toHaveLength(2)
    expect(trilha1[0]).toBe(primeiro) // mesma referência: nada foi mutado
    expect(trilha0).toHaveLength(1) // a trilha original é preservada
    expect(trilha1[1]).toMatchObject({ id: 2, tarefaId: 100, tipoEvento: "devolucao_concluida", deColaboradorId: 9, paraColaboradorId: null })
  })

  it("a API de trilha do módulo é só append + leitura (sem editar/excluir)", async () => {
    const modulo = await import("../historico")
    const exports = Object.keys(modulo).sort()
    // Apenas: registrarEvento (append), leituras puras e (re)export de tipos.
    expect(exports).not.toContain("editarRegistro")
    expect(exports).not.toContain("excluirRegistro")
    expect(exports).not.toContain("remover")
    expect(exports).toContain("registrarEvento")
    expect(exports).toContain("historicoCronologico")
    expect(exports).toContain("eventosDaTarefa")
  })

  it("historicoCronologico ordena por (criadoEm, id) — id desempata instantes iguais", () => {
    const a = reg({ id: 5, tarefaId: 100, criadoEm: AGORA, tipoEvento: "reatribuicao" })
    const b = reg({ id: 3, tarefaId: 100, criadoEm: AGORA, tipoEvento: "delegacao" })
    const c = reg({ id: 9, tarefaId: 100, criadoEm: AGORA_2, tipoEvento: "devolucao_concluida" })
    const d = reg({ id: 1, tarefaId: 100, criadoEm: AGORA_1, tipoEvento: "delegacao" })

    expect(historicoCronologico([a, b, c, d]).map((r) => r.id)).toEqual([1, 3, 5, 9])
  })

  it("aceita Date e string em criadoEm na ordenação", () => {
    const a = reg({ id: 2, tarefaId: 100, criadoEm: new Date(AGORA) })
    const b = reg({ id: 1, tarefaId: 100, criadoEm: AGORA_1 })
    expect(historicoCronologico([a, b]).map((r) => r.id)).toEqual([1, 2])
  })

  it("eventosDaTarefa filtra pela tarefa (escopo da tela de histórico)", () => {
    const t1a = reg({ id: 1, tarefaId: 100, criadoEm: AGORA_1, tipoEvento: "delegacao" })
    const t2a = reg({ id: 2, tarefaId: 200, criadoEm: AGORA, tipoEvento: "delegacao" })
    const t1b = reg({ id: 3, tarefaId: 100, criadoEm: AGORA_2, tipoEvento: "mudanca_status" })
    const r = eventosDaTarefa([t1a, t2a, t1b], 100)
    expect(r.map((e) => e.id)).toEqual([1, 3])
  })

  it("eventosDaTarefa de tarefa inexistente é vazio", () => {
    expect(eventosDaTarefa([], 999)).toEqual([])
  })

  it("fluxo completo gera trilha coerente (delegação → devolução → re-delegação → conclusão)", () => {
    let trilha: RegistroHistorico[] = []
    let proximoId = 1

    const passo = (t: TarefaFluxo, acao: AcaoFluxo, extra: {
      responsavelAlvo?: ColaboradorDestino
      mensagem?: string
      agora?: string
    }) => {
      const r = trans(t, acao, extra)
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("não alcançável")
      trilha = registrarEvento(trilha, r.evento, {
        tarefaId: t.id,
        novoId: proximoId++,
        agora: extra.agora ?? AGORA,
      })
      return {
        status: r.efeito.status,
        responsavelId: r.efeito.responsavelId,
      }
    }

    const s1 = passo(tarefa({ status: "aberta" }), "delegar", {
      responsavelAlvo: colaborador({ id: 9 }),
      agora: AGORA_1,
    })
    expect(s1).toEqual({ status: "delegada", responsavelId: 9 })

    const s2 = passo(tarefa({ status: "delegada", responsavelId: 9 }), "devolver_precisa_informacoes", {
      mensagem: "Falta dados.",
      agora: AGORA,
    })
    expect(s2.status).toBe("precisa_informacoes")

    const s3 = passo(tarefa({ status: "precisa_informacoes", responsavelId: 9 }), "delegar", {
      responsavelAlvo: colaborador({ id: 12 }),
      agora: AGORA_2,
    })
    expect(s3).toEqual({ status: "delegada", responsavelId: 12 })

    const s4 = passo(tarefa({ status: "delegada", responsavelId: 12 }), "devolver_concluida", {
      mensagem: "Entregue.",
      agora: AGORA_2,
    })
    expect(s4.status).toBe("concluida")

    expect(historicoCronologico(trilha).map((e) => e.tipoEvento)).toEqual([
      "delegacao",
      "devolucao_precisa_info",
      "reatribuicao",
      "devolucao_concluida",
    ])
  })
})
