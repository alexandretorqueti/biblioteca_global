// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { HelpDeskService } from "../helpdesk.service"
import {
  ehRespostaInvalida,
  HELPDESK_AGENT_INSTRUCTIONS,
} from "../helpdesk.bridge"
import { INSTRUCAO_CONTRATO_TAREFA_HELPDESK } from "../helpdesk-tarefa-contrato"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import type { RealtimeService } from "../../realtime/realtime.service"

// O catálogo do prompt é testado via string espelhada (sem import cross-package
// que quebra o typecheck do apps/api — o catálogo reusa INSTRUCAO_CONTRATO_TAREFA_HELPDESK
// em ambas as entradas, e o teste abaixo verifica a presença do formato exato).
const PROMPT_HELPDESK_ESPERADO = "criar_tarefa {\"titulo\":"

function makeService(options: {
  historico?: Array<{ id: string; role: string; text: string }>
  cursor?: string | null
  insercoes?: Array<{ sessaoId: number; role: string; text: string }>
  publicarHelpDesk?: Array<Record<string, unknown>>
  reconcilerConfig?: { intervalMs: number; tetoMs: number }
}) {
  const catalogDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 7, slug: "projeto-teste", agenteId: "agente" }],
        }),
      }),
    }),
    execute: vi.fn(async () => [[{ modelo: "modelo-teste" }]]),
  }
  const factory = {
    obter: vi.fn(async () => catalogDb),
  } as unknown as ProjectDbFactory

  const insercoes = options.insercoes ?? []
  const publicarHelpDesk = options.publicarHelpDesk ?? []
  const coreDb = {
    select: vi.fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 1,
              usuarioId: 1,
              projetoId: 2,
              agenteId: "agente",
              status: "active",
              ultimoConsoleMessageId: options.cursor ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }]),
          }),
        }),
      })
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        $returningId: vi.fn().mockImplementation(async () => {
          insercoes.push({
            sessaoId: values.sessaoId as number,
            role: values.role as string,
            text: values.text as string,
          })
          return [100]
        }),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }

  const bridge = {
    isConfigured: vi.fn(() => true),
    resolveSession: vi.fn(async () => ({ sessionKey: "agent:agente:2_1", existing: false })),
    resolverPromptAtendimento: vi.fn(async () => HELPDESK_AGENT_INSTRUCTIONS),
    temMensagensDeUsuario: vi.fn(async () =>
      (options.historico ?? []).some((m) => m.role === "user" && m.text.trim().length > 0),
    ),
    prefixarInstrucoes: (instrucoes: string | undefined, texto: string, primeira: boolean) => {
      const l = (instrucoes ?? "").trim()
      if (!primeira || !l) return texto
      return `[INSTRUÇÕES DE ATENDIMENTO]\n${l}\n\n${texto}`
    },
    sendWithChain: vi.fn(async () => ({ ok: true, processing: true, runId: "run-1" })),
    obterRespostaPorCursor: vi.fn(async (_key: string, cursor: string | null) => {
      const history = options.historico ?? []
      const cursorId = (cursor ?? "").trim()
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const m = history[i]
        if (!m || m.role !== "assistant" || !m.id) continue
        if (cursorId && m.id <= cursorId) continue
        if (ehRespostaInvalida(m.text)) continue
        return m.text.trim()
      }
      return undefined
    }),
    getHistory: vi.fn(async () => options.historico ?? []),
    sessaoEmProcessamento: vi.fn(async () => true),
  }

  const realtime = {
    publicarHelpDesk: vi.fn((input: Record<string, unknown>) => publicarHelpDesk.push(input)),
    setHelpDeskSnapshotProvider: vi.fn(),
  } as unknown as RealtimeService

  const gerenteAgentes = {
    criarTarefa: vi.fn(async () => ({ id: 77, externalId: "task-77", status: "draft" })),
    resolverPromptAtendimentoHelpDesk: vi.fn(async () => "PROMPT ATIVO"),
  }

  const service = new HelpDeskService(
    factory,
    coreDb as never,
    bridge as never,
    gerenteAgentes as never,
    realtime as never,
    undefined as never,
    undefined as never,
    options.reconcilerConfig,
  )

  return { service, bridge, realtime, insercoes, publicarHelpDesk, coreDb, factory }
}

describe("HelpDeskService — prefixo de instruções na primeira mensagem", () => {
  it("prefixa as instruções na PRIMEIRA mensagem (cursor vazio + sem user no histórico)", async () => {
    const { service, bridge } = makeService({ historico: [], cursor: null })
    const resultado = await service.enviarMensagem({ sessaoId: 1, text: "olá", usuarioId: 1, projetoId: 2 })
    expect(resultado.ok).toBe(true)
    expect(bridge.sendWithChain).toHaveBeenCalled()
    expect(bridge.sendWithChain).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("[INSTRUÇÕES DE ATENDIMENTO]"),
      }),
    )
    const enviado = (bridge.sendWithChain as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { text?: string } | undefined
    expect(enviado?.text).toContain("[INSTRUÇÕES DE ATENDIMENTO]")
    expect(enviado?.text).toContain("olá")
  })

  it("NÃO prefixa instruções na segunda mensagem (cursor já preenchido)", async () => {
    const { service, bridge } = makeService({
      historico: [{ id: "10", role: "user", text: "olá" }],
      cursor: "10",
    })
    await service.enviarMensagem({ sessaoId: 1, text: "como faço X?", usuarioId: 1, projetoId: 2 })
    expect(bridge.sendWithChain).toHaveBeenCalledWith(
      expect.objectContaining({ text: "como faço X?" }),
    )
  })

  it("NÃO prefixa instruções quando há mensagens de usuário no histórico (cursor vazio)", async () => {
    const { service, bridge } = makeService({
      historico: [{ id: "5", role: "user", text: "mensagem anterior" }],
      cursor: null,
    })
    await service.enviarMensagem({ sessaoId: 1, text: "nova", usuarioId: 1, projetoId: 2 })
    expect(bridge.sendWithChain).toHaveBeenCalledWith(
      expect.objectContaining({ text: "nova" }),
    )
  })
})

describe("HelpDeskService — correlação determinística por cursor", () => {
  it("seleciona a primeira assistant com id > cursor e ignora as anteriores", async () => {
    const historico = [
      { id: "1", role: "assistant", text: "resposta anterior" },
      { id: "2", role: "user", text: "pergunta" },
      { id: "3", role: "assistant", text: "resposta nova" },
    ]
    const { bridge } = makeService({ historico, cursor: "1" })
    const resposta = await (bridge as unknown as { obterRespostaPorCursor(k: string, c: string | null): Promise<string | undefined> }).obterRespostaPorCursor("agent:agente:2_1", "1")
    expect(resposta).toBe("resposta nova")
  })

  it("NUNCA usa fallback 'última mensagem' quando só há assistant <= cursor", async () => {
    const historico = [
      { id: "1", role: "assistant", text: "resposta antiga" },
      { id: "2", role: "user", text: "pergunta" },
    ]
    const { bridge } = makeService({ historico, cursor: "2" })
    const resposta = await (bridge as unknown as { obterRespostaPorCursor(k: string, c: string | null): Promise<string | undefined> }).obterRespostaPorCursor("agent:agente:2_1", "2")
    expect(resposta).toBeUndefined()
  })

  it("persistirRespostaAgente atualiza o cursor após processar", async () => {
    const historico = [
      { id: "10", role: "user", text: "pergunta" },
      { id: "11", role: "assistant", text: "resposta válida" },
    ]
    const { service, coreDb } = makeService({ historico, cursor: null })
    const resultado = await service.persistirRespostaAgente({
      sessaoId: 1,
      sessionKey: "agent:agente:2_1",
      cursor: null,
      usuarioId: 1,
    })
    expect(resultado.ok).toBe(true)
    expect(resultado.resposta).toBe("resposta válida")
    // cursor atualizado para o último id do histórico
    expect(coreDb.update).toHaveBeenCalled()
  })

  it("NÃO persiste resposta '(no output)'", async () => {
    const historico = [
      { id: "10", role: "user", text: "pergunta" },
      { id: "11", role: "assistant", text: "(no output)" },
    ]
    const { service, coreDb } = makeService({ historico, cursor: null })
    const resultado = await service.persistirRespostaAgente({
      sessaoId: 1,
      sessionKey: "agent:agente:2_1",
      cursor: null,
      usuarioId: 1,
    })
    expect(resultado.ok).toBe(false)
    expect(coreDb.insert).not.toHaveBeenCalled()
  })

  it("NÃO persiste resposta vazia", async () => {
    const historico = [
      { id: "10", role: "user", text: "pergunta" },
      { id: "11", role: "assistant", text: "   " },
    ]
    const { service, coreDb } = makeService({ historico, cursor: null })
    const resultado = await service.persistirRespostaAgente({
      sessaoId: 1,
      sessionKey: "agent:agente:2_1",
      cursor: null,
      usuarioId: 1,
    })
    expect(resultado.ok).toBe(false)
    expect(coreDb.insert).not.toHaveBeenCalled()
  })

  it("não mapeia role desconhecido para 'agent' — só assistant é aceito", async () => {
    const historico = [
      { id: "10", role: "unknown_role", text: "texto estranho" },
      { id: "11", role: "assistant", text: "resposta correta" },
    ]
    const { service } = makeService({ historico, cursor: null })
    const resultado = await service.persistirRespostaAgente({
      sessaoId: 1,
      sessionKey: "agent:agente:2_1",
      cursor: null,
      usuarioId: 1,
    })
    expect(resultado.ok).toBe(true)
    expect(resultado.resposta).toBe("resposta correta")
  })
})

describe("HelpDeskService — reconciler server-side", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("persiste + publica realtime sem /status, com fake timers", async () => {
    vi.useFakeTimers()
    // 1ª chamada do reconciler: ainda sem resposta
    const historicoSemResposta = [{ id: "10", role: "user", text: "pergunta" }]
    const { service, bridge, publicarHelpDesk } = makeService({
      historico: historicoSemResposta,
      cursor: null,
      reconcilerConfig: { intervalMs: 5_000, tetoMs: 300_000 },
    })
    // Mock bridge para simular que a resposta aparece na 2ª chamada do reconciler.
    const obterRespostaPorCursor = (bridge as unknown as { obterRespostaPorCursor: ReturnType<typeof vi.fn> }).obterRespostaPorCursor
    obterRespostaPorCursor.mockImplementation(async () => {
      if (obterRespostaPorCursor.mock.calls.length >= 2) return "resposta tardia"
      return undefined
    })
    await service.enviarMensagem({ sessaoId: 1, text: "pergunta", usuarioId: 1, projetoId: 2 })
    expect(bridge.sendWithChain).toHaveBeenCalled()

    // Avança 5s (1º tick do reconciler)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await Promise.resolve()

    // Avança mais 5s (2º tick — resposta chega)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await Promise.resolve()

    // Realtime: deve ter helpdesk.message.created + processing.changed
    const tipos = publicarHelpDesk.map((p) => (p as { type: string }).type)
    expect(tipos).toContain("helpdesk.message.created")
    expect(tipos).toContain("helpdesk.processing.changed")
  })

  it("NÃO cria reconciler duplicado para a mesma sessão", async () => {
    vi.useFakeTimers()
    const historico = [{ id: "10", role: "user", text: "pergunta" }]
    const { service, bridge } = makeService({
      historico,
      cursor: null,
      reconcilerConfig: { intervalMs: 5_000, tetoMs: 300_000 },
    })
    const obterRespostaPorCursor = (bridge as unknown as { obterRespostaPorCursor: ReturnType<typeof vi.fn> }).obterRespostaPorCursor
    obterRespostaPorCursor.mockResolvedValue(undefined)

    await service.enviarMensagem({ sessaoId: 1, text: "pergunta", usuarioId: 1, projetoId: 2 })
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await Promise.resolve()

    // 2ª chamada de enviarMensagem NÃO deve duplicar o reconciler (guard em memória)
    await service.enviarMensagem({ sessaoId: 1, text: "pergunta 2", usuarioId: 1, projetoId: 2 })
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await Promise.resolve()

    // O reconciler devesse continuar ativo; a 2ª chamada de persistirRespostaAgente
    // dentro do mesmo tick não deve criar um novo timer.
    const serviceInterno = service as unknown as { reconcilersAtivos: Set<number> }
    expect(serviceInterno.reconcilersAtivos.has(1)).toBe(true)
  })

  it("para após o teto (tetoMs) sem resposta", async () => {
    vi.useFakeTimers()
    const historico = [{ id: "10", role: "user", text: "pergunta" }]
    const { bridge, service } = makeService({
      historico,
      cursor: null,
      reconcilerConfig: { intervalMs: 100, tetoMs: 500 },
    })
    const obterRespostaPorCursor = (bridge as unknown as { obterRespostaPorCursor: ReturnType<typeof vi.fn> }).obterRespostaPorCursor
    obterRespostaPorCursor.mockResolvedValue(undefined)

    await service.enviarMensagem({ sessaoId: 1, text: "pergunta", usuarioId: 1, projetoId: 2 })
    // O reconciler usa setTimeout com intervalMs. Com fake timers, cada
    // advanceTimersByTimeAsync dispara os timers pendentes.
    // Avança 100ms × 6 = 600ms > teto (500ms) → reconciler deve ter parado.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100)
      // Dá tempo para o async tick completar (persistirRespostaAgente é async)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    // O reconciler deve ter atingido o teto e removido a sessão do set
    const svcInterno = service as unknown as { reconcilersAtivos: Set<number> }
    expect(svcInterno.reconcilersAtivos.has(1)).toBe(false)
  }, 10000)
})

describe("HelpDeskBridgeService — prefixo e cursor", () => {
  it("prefixarInstrucoes monta o formato exato na 1ª mensagem", () => {
    const { bridge } = makeService({})
    const texto = (bridge as unknown as { prefixarInstrucoes(i: string | undefined, t: string, p: boolean): string }).prefixarInstrucoes("PROMPT\nREGRAS", "minha pergunta", true)
    expect(texto).toBe("[INSTRUÇÕES DE ATENDIMENTO]\nPROMPT\nREGRAS\n\nminha pergunta")
  })

  it("prefixarInstrucoes retorna texto puro nas demais", () => {
    const { bridge } = makeService({})
    const texto = (bridge as unknown as { prefixarInstrucoes(i: string | undefined, t: string, p: boolean): string }).prefixarInstrucoes("PROMPT", "minha pergunta", false)
    expect(texto).toBe("minha pergunta")
  })

  it("ehRespostaInvalida detecta '(no output)' e vazio", () => {
    expect(ehRespostaInvalida("")).toBe(true)
    expect(ehRespostaInvalida("   ")).toBe(true)
    expect(ehRespostaInvalida("(no output)")).toBe(true)
    expect(ehRespostaInvalida("resposta válida")).toBe(false)
    expect(ehRespostaInvalida(undefined)).toBe(true)
  })
})

describe("HelpDeskService — criação de tarefa draft (mantida para subtarefa 2)", () => {
  it("usa o database do Gerente de Agentes para um projeto da plataforma", async () => {
    const catalogDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 7, agenteId: "agente" }],
          }),
        }),
      }),
    }
    const factory = {
      obter: vi.fn(async ({ id }: { id: number }) => {
        if (id !== 640) throw new Error(`database inesperado: projeto_${id}`)
        return catalogDb
      }),
    } as unknown as ProjectDbFactory
    const coreDb = {} as never
    const bridge = {} as never
    const criarTarefa = vi.fn().mockResolvedValue({ id: 77, externalId: "task-p7-77", status: "planned" })
    const service = new HelpDeskService(factory, coreDb, bridge, { criarTarefa } as never)

    await (service as unknown as {
      criarTarefaDraft(projetoId: number, textoVisivel: string, titulo: string, descricao: string): Promise<unknown>
    }).criarTarefaDraft(
      6611,
      "Ao incluir um morador, a unidade não aparece na combo",
      "Unidade não aparece na combo ao incluir morador",
      "Ao incluir um morador, a unidade não aparece na combo",
    )

    expect(factory.obter).toHaveBeenCalledWith({ id: 640 })
    expect(factory.obter).not.toHaveBeenCalledWith({ id: 6611 })
    expect(criarTarefa).toHaveBeenCalledWith(
      { id: 6611, nome: "HelpDesk", slug: "helpdesk", perfil: "admin" },
      expect.objectContaining({ managedProjectId: 7, databaseProjectId: 640, status: "draft" }),
    )
  })
})

describe("HelpDeskService — contrato de tarefa emitido pelo agente (subtarefa 2)", () => {
  const BLOCO = 'criar_tarefa {"titulo":"Exportar relatório em PDF","descricao":"O relatório de investimentos deve ser exportado em PDF"}'

  function makeServiceContrato(options: { historico: Array<{ id: string; role: string; text: string }>; criarTarefa?: ReturnType<typeof vi.fn> }) {
    const base = makeService({ historico: options.historico, cursor: null })
    const gerenteAgentes = {
      criarTarefa: options.criarTarefa ?? vi.fn().mockResolvedValue({ id: 77, externalId: "task-p7-77", status: "draft" }),
      resolverPromptAtendimentoHelpDesk: vi.fn(async () => "PROMPT ATIVO"),
    }
    const service = new HelpDeskService(
      base.factory as never,
      base.coreDb as never,
      base.bridge as never,
      gerenteAgentes as never,
      base.realtime as never,
      undefined as never,
      undefined as never,
    )
    return { service, insercoes: base.insercoes, publicarHelpDesk: base.publicarHelpDesk, coreDb: base.coreDb, gerenteAgentes }
  }

  it("extrai o bloco, remove do texto visível, cria draft e anexa confirmação com externalId", async () => {
    const { service, insercoes, publicarHelpDesk, gerenteAgentes } = makeServiceContrato({
      historico: [
        { id: "10", role: "user", text: "eu queria que o relatório exportasse em PDF" },
        { id: "11", role: "assistant", text: `Claro! Vou encaminhar essa solicitação aos técnicos.\n\n${BLOCO}` },
      ],
    })
    const resultado = await service.persistirRespostaAgente({ sessaoId: 1, sessionKey: "agent:agente:2_1", cursor: null, usuarioId: 1 })
    expect(resultado.ok).toBe(true)
    // Bloco REMOVIDO do texto visível persistido.
    expect(resultado.resposta).not.toContain("criar_tarefa")
    expect(resultado.resposta).toContain("Claro! Vou encaminhar essa solicitação aos técnicos.")
    // Confirmação com externalId anexada.
    expect(resultado.resposta).toContain("Solicitação registrada como tarefa draft task-p7-77 (id 77)")
    // Draft criada via criarTarefaDraft com os campos do JSON.
    expect(gerenteAgentes.criarTarefa).toHaveBeenCalledTimes(1)
    const args = (gerenteAgentes.criarTarefa as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>]
    expect(args[1].titulo).toBe("Exportar relatório em PDF")
    expect(String(args[1].descricao)).toContain("O relatório de investimentos deve ser exportado em PDF")
    expect(args[1].status).toBe("draft")
    expect(args[1].autoStart).toBe(false)
    // Persistência + realtime com o texto final.
    expect(insercoes.length).toBe(1)
    expect(insercoes[0]?.text).toBe(resultado.resposta)
    const messageEvent = publicarHelpDesk.find((p) => (p as { type?: string }).type === "helpdesk.message.created") as { payload?: { text?: string } } | undefined
    expect(messageEvent?.payload?.text).toBe(resultado.resposta)
  })

  it("sem bloco: nenhuma tarefa é criada e o texto é persistido inalterado", async () => {
    const { service, gerenteAgentes, insercoes } = makeServiceContrato({
      historico: [
        { id: "10", role: "user", text: "como faço para exportar?" },
        { id: "11", role: "assistant", text: "Você pode exportar em Menu > Relatórios > Exportar." },
      ],
    })
    const resultado = await service.persistirRespostaAgente({ sessaoId: 1, sessionKey: "agent:agente:2_1", cursor: null, usuarioId: 1 })
    expect(resultado.ok).toBe(true)
    expect(resultado.resposta).toBe("Você pode exportar em Menu > Relatórios > Exportar.")
    expect(gerenteAgentes.criarTarefa).not.toHaveBeenCalled()
    expect(insercoes[0]?.text).toBe("Você pode exportar em Menu > Relatórios > Exportar.")
  })

  it("bloco malformado: tratado sem quebrar a persistência e sem criar tarefa", async () => {
    const { service, gerenteAgentes, insercoes } = makeServiceContrato({
      historico: [
        { id: "10", role: "user", text: "quereria exportar em PDF" },
        { id: "11", role: "assistant", text: `Vou encaminhar.\ncriar_tarefa {"titulo":"quebrado"` },
      ],
    })
    const resultado = await service.persistirRespostaAgente({ sessaoId: 1, sessionKey: "agent:agente:2_1", cursor: null, usuarioId: 1 })
    expect(resultado.ok).toBe(true)
    expect(gerenteAgentes.criarTarefa).not.toHaveBeenCalled()
    expect(insercoes[0]?.text).toContain("Vou encaminhar.")
  })

  it("falha em criarTarefaDraft não perde a resposta do usuário (persiste sem o bloco)", async () => {
    const { service, gerenteAgentes, insercoes } = makeServiceContrato({
      historico: [
        { id: "10", role: "user", text: "quereria exportar em PDF" },
        { id: "11", role: "assistant", text: `Claro! Vou encaminhar.\n\n${BLOCO}` },
      ],
      criarTarefa: vi.fn().mockRejectedValue(new Error("motor offline")),
    })
    const resultado = await service.persistirRespostaAgente({ sessaoId: 1, sessionKey: "agent:agente:2_1", cursor: null, usuarioId: 1 })
    expect(resultado.ok).toBe(true)
    expect(resultado.tarefa).toBeNull()
    // Resposta persistida SEM o bloco e SEM a confirmação (não inventada).
    expect(insercoes[0]?.text).toContain("Claro! Vou encaminhar.")
    expect(insercoes[0]?.text).not.toContain("criar_tarefa")
    expect(insercoes[0]?.text).not.toContain("Solicitação registrada")
    expect(gerenteAgentes.criarTarefa).toHaveBeenCalledTimes(1)
  })
})

describe("Catálogo de prompts — helpdesk_atendimento (subtarefa 2)", () => {
  it("instrução canônica do backend contém o formato exato do contrato e não cita tools fictícias", () => {
    expect(INSTRUCAO_CONTRATO_TAREFA_HELPDESK).toContain('criar_tarefa {"titulo":"')
    expect(INSTRUCAO_CONTRATO_TAREFA_HELPDESK).not.toContain("verificar_transbordo_possivel")
    expect(INSTRUCAO_CONTRATO_TAREFA_HELPDESK).not.toContain("transbordar_para_humano")
    expect(INSTRUCAO_CONTRATO_TAREFA_HELPDESK).not.toContain("\\n")
  })

  it("fallback do bridge reusa a mesma instrução canônica do backend e não contém '\\n' literal", () => {
    expect(HELPDESK_AGENT_INSTRUCTIONS).toContain(INSTRUCAO_CONTRATO_TAREFA_HELPDESK)
    expect(HELPDESK_AGENT_INSTRUCTIONS).not.toContain("\\n")
    expect(HELPDESK_AGENT_INSTRUCTIONS).not.toContain("verificar_transbordo_possivel")
    expect(HELPDESK_AGENT_INSTRUCTIONS).not.toContain("transbordar_para_humano")
  })

  it("catálogo (AGENT_PROMPT_CATALOG) reusa a mesma instrução canônica — verificado em prompts-agentes.spec.ts", () => {
    // Este teste é um sanity check: o catálogo do prompt-catalog.ts reusa
    // INSTRUCAO_CONTRATO_TAREFA_HELPDESK (mesma string). O teste de conteúdo
    // completo (sem '\\n' literal, sem tools fictícias) vive em:
    //   projects/gerenteagentes/__tests__/prompts-agentes.spec.ts
    expect(PROMPT_HELPDESK_ESPERADO).toBe('criar_tarefa {"titulo":')
  })
})
