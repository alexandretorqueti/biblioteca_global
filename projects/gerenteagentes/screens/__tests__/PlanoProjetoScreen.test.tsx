// @vitest-environment jsdom
/**
 * Testes da PlanoProjetoScreen (Geração Macro F2 — subtarefa 1):
 * - render com plano completo (contrato §5) + decisões em awaiting_approval
 * - render tolerante com tasks ausente/nulo e plano parcial (sem crash)
 * - botões de decisão visíveis apenas em awaiting_approval
 * - cada decisão POSTa o body correto em
 *   POST /gerenteagentes/projetos-captados/:id/geracoes/:geracaoId/aprovar
 *   (approve simples, approve com planoEditado após edição, revise com
 *   comentário, reject)
 * - erro 422 "Plano macro inválido: ..." surfacado em Alert sem quebrar a tela
 * - chat de clarificação: mensagens via GET e resposta via POST role=user
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import PlanoProjetoScreen from "../PlanoProjetoScreen"

// Mock do useApi (bundle fake) — a tela não fala HTTP direto.
vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

declare global {
  // eslint-disable-next-line no-var
  var __bundleFalso: unknown
}

/** Plano completo no formato do contrato §5 (fixture válida p/ validarPlanoMacro). */
const planoCompleto = {
  kind: "plano",
  classificacaoSistema: "misto",
  requerAgenteDedicado: true,
  requisitos: [
    { id: "REQ-F-001", texto: "Cadastro de clientes", origem: "reunião 01/11", classificacao: "crud" },
    { id: "REQ-F-002", texto: "Integração com gateway de pagamento", origem: "e-mail", classificacao: "custom" },
    { id: "REQ-F-003", texto: "Relatório fiscal mensal", origem: "chat Isa", classificacao: "lacuna" },
  ],
  especificacaoCrud: {
    entidades: [
      {
        nome: "Cliente",
        campos: ["nome", "cpf", "email"],
        mascarasValidacoes: ["CPF 000.000.000-00", "e-mail válido"],
        menu: "Cadastros",
      },
    ],
    observacoes: "Gerado pela Biblioteca Global",
  },
  tarefas: [
    {
      seq: 1,
      titulo: "CRUD de Cliente",
      objetivo: "Criar o CRUD de clientes",
      escopo: "schema + tela de cadastro",
      aceite: ["tela lista clientes", "validação de CPF ativa"],
      requisitos: ["REQ-F-001"],
      executor: "biblioteca-global",
      depende_de: [],
      auto_start: true,
      risco: "baixo",
    },
    {
      seq: 2,
      titulo: "Integração gateway",
      objetivo: "Integrar o gateway de pagamento",
      escopo: "API + webhook",
      aceite: ["webhook confirmado em sandbox"],
      requisitos: ["REQ-F-002"],
      executor: "agente-projeto",
      depende_de: [1],
      auto_start: false,
      risco: "alto",
    },
  ],
  matrizCobertura: [
    { req: "REQ-F-001", cobertoPor: "tarefa:1" },
    { req: "REQ-F-002", cobertoPor: "tarefa:2" },
    { req: "REQ-F-003", cobertoPor: "fora_de_fase", justificativa: "sem capacidade nativa" },
  ],
  lacunas: ["Relatório fiscal não suportado pelo núcleo"],
  lacunasBiblioteca: [
    { funcionalidade: "Emissão de NFS-e", req: "REQ-F-003", contexto: "biblioteca não cobre nativamente" },
  ],
  riscos: ["Dependência de credencial externa do gateway"],
  foraDeFase: [{ req: "REQ-F-003", motivo: "aguardar capacidade da biblioteca" }],
}

const chatFixture = [
  { id: 1, projetoId: 7, role: "analyst", texto: "Qual o prazo desejado para o relatório fiscal?", createdAt: "2026-11-01T10:00:00.000Z" },
  { id: 2, projetoId: 7, role: "system", texto: "Geração iniciada.", createdAt: "2026-11-01T09:00:00.000Z" },
]

let geracoesResp: unknown = []
let chatResp: unknown = []
let aprovarDeveFalhar = false
let aprovarStatus = 200

const mockRequest = vi.fn((method: string, path: string, opts?: { body?: unknown }) => {
  if (method === "GET" && path.endsWith("/geracoes")) {
    return Promise.resolve(geracoesResp)
  }
  if (method === "GET" && path.endsWith("/chat")) {
    return Promise.resolve(chatResp)
  }
  if (method === "POST" && path.includes("/aprovar")) {
    if (aprovarDeveFalhar) {
      return Promise.reject(
        Object.assign(new Error("Plano macro inválido: tarefas com seq duplicado"), {
          status: aprovarStatus,
          name: "ApiClientError",
        }),
      )
    }
    return Promise.resolve({ ok: true, decisao: (opts?.body as { decisao?: string })?.decisao })
  }
  if (method === "POST" && path.endsWith("/chat")) {
    return Promise.resolve({ ok: true })
  }
  return Promise.resolve({})
})

function bundleFalso() {
  return {
    http: {
      request: (method: string, path: string, opts?: { body?: unknown }) =>
        mockRequest(method, path, opts),
    },
  } as never
}

function geracao(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    projetoId: 7,
    status: "awaiting_approval",
    tasks: planoCompleto,
    modelo: "gpt-5.6-luna",
    erro: null,
    feedback: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T11:00:00.000Z",
    ...overrides,
  }
}

const parentRow = { id: 7, nome: "Projeto X", slug: "projeto-x" }

beforeEach(() => {
  mockRequest.mockReset()
  geracoesResp = [geracao()]
  chatResp = chatFixture
  aprovarDeveFalhar = false
  aprovarStatus = 200
  globalThis.__bundleFalso = bundleFalso()
})

function chamadasAprovar(): Array<{ path: string; body: Record<string, unknown> }> {
  return mockRequest.mock.calls
    .filter(([m, p]) => m === "POST" && String(p).includes("/aprovar"))
    .map(([, p, opts]) => ({
      path: String(p),
      body: ((opts as { body?: Record<string, unknown> })?.body ?? {}) as Record<string, unknown>,
    }))
}

async function renderizar() {
  render(<PlanoProjetoScreen parentRow={parentRow} />)
  await waitFor(() => {
    expect(screen.getByTestId("painel-geracao")).toBeInTheDocument()
  })
}

function textboxDe(testid: string): HTMLElement {
  return within(screen.getByTestId(testid)).getByRole("textbox")
}

describe("PlanoProjetoScreen", () => {
  it("renderiza o plano completo (contrato §5) e as decisões em awaiting_approval", async () => {
    await renderizar()

    // Estado da geração
    expect(screen.getByTestId("status-geracao")).toHaveTextContent("Aguardando aprovação")
    expect(screen.getByTestId("classificacao-sistema")).toHaveTextContent("misto")
    expect(screen.getByTestId("requer-agente")).toHaveTextContent("Requer agente dedicado")

    // Requisitos com classificação
    expect(screen.getByTestId("secao-requisitos")).toHaveTextContent("REQ-F-001")
    expect(screen.getByTestId("secao-requisitos")).toHaveTextContent("Cadastro de clientes")
    expect(screen.getByTestId("secao-requisitos")).toHaveTextContent("lacuna")

    // Tarefas com objetivo/escopo/aceite/executor/dependências/risco
    const tarefas = screen.getByTestId("secao-tarefas")
    expect(tarefas).toHaveTextContent("CRUD de Cliente")
    expect(tarefas).toHaveTextContent("Criar o CRUD de clientes")
    expect(tarefas).toHaveTextContent("schema + tela de cadastro")
    expect(tarefas).toHaveTextContent("validação de CPF ativa")
    expect(tarefas).toHaveTextContent("biblioteca-global")
    expect(tarefas).toHaveTextContent("risco alto")
    expect(tarefas).toHaveTextContent("Depende de: nenhuma")

    // Especificação CRUD
    const espec = screen.getByTestId("secao-especificacao-crud")
    expect(espec).toHaveTextContent("Cliente")
    expect(espec).toHaveTextContent("nome, cpf, email")
    expect(espec).toHaveTextContent("CPF 000.000.000-00")
    expect(espec).toHaveTextContent("Cadastros")

    // Matriz de cobertura, lacunas, lacunasBiblioteca, riscos, foraDeFase
    expect(screen.getByTestId("secao-matriz-cobertura")).toHaveTextContent("tarefa:1")
    expect(screen.getByTestId("secao-matriz-cobertura")).toHaveTextContent("sem capacidade nativa")
    expect(screen.getByTestId("secao-lacunas")).toHaveTextContent("Relatório fiscal não suportado pelo núcleo")
    expect(screen.getByTestId("secao-lacunas-biblioteca")).toHaveTextContent("Emissão de NFS-e")
    expect(screen.getByTestId("secao-riscos")).toHaveTextContent("Dependência de credencial externa do gateway")
    expect(screen.getByTestId("secao-fora-de-fase")).toHaveTextContent("aguardar capacidade da biblioteca")

    // 4 decisões visíveis
    expect(screen.getByTestId("btn-aprovar")).toBeEnabled()
    expect(screen.getByTestId("btn-editar")).toBeEnabled()
    expect(screen.getByTestId("btn-revisar")).toBeEnabled()
    expect(screen.getByTestId("btn-rejeitar")).toBeEnabled()

    // Chat carregado
    expect(screen.getByTestId("chat-mensagens")).toHaveTextContent("Qual o prazo desejado para o relatório fiscal?")
  })

  it("renderiza tolerante com tasks nulo (sem plano) e sem geração", async () => {
    geracoesResp = [geracao({ tasks: null, status: "running" })]
    await renderizar()
    expect(screen.getByTestId("sem-plano")).toHaveTextContent("Sem plano registrado para esta geração.")

    // Sem geração alguma
    geracoesResp = []
    render(<PlanoProjetoScreen parentRow={parentRow} />)
    await waitFor(() => {
      expect(screen.getAllByTestId("sem-geracao").length).toBeGreaterThan(0)
    })
  })

  it("renderiza tolerante com plano parcial (seções ausentes viram placeholder)", async () => {
    geracoesResp = [geracao({ tasks: { kind: "plano" }, status: "awaiting_approval" })]
    await renderizar()
    expect(screen.getByTestId("secao-requisitos")).toHaveTextContent("Requisitos (0)")
    expect(screen.getByTestId("secao-requisitos")).toHaveTextContent("—")
    expect(screen.getByTestId("secao-tarefas")).toHaveTextContent("Tarefas do plano (0)")
    expect(screen.getByTestId("secao-matriz-cobertura")).toHaveTextContent("Matriz de cobertura (0)")
    expect(screen.getByTestId("secao-lacunas-biblioteca")).toHaveTextContent("Lacunas da Biblioteca (0)")
    // Editar fica indisponível sem tarefas editáveis? (plano existe → botão habilitado,
    // mas entrar em edição com 0 tarefas não quebra)
    expect(screen.getByTestId("btn-aprovar")).toBeEnabled()
  })

  it("não mostra botões de decisão fora de awaiting_approval", async () => {
    geracoesResp = [geracao({ status: "running" })]
    await renderizar()
    expect(screen.queryByTestId("btn-aprovar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("btn-editar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("btn-revisar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("btn-rejeitar")).not.toBeInTheDocument()
  })

  it("Aprovar POSTa decisao=approve no endpoint da geração", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-aprovar"))
    await waitFor(() => {
      const chamadas = chamadasAprovar()
      expect(chamadas.length).toBe(1)
      expect(chamadas[0]!.path).toBe("/gerenteagentes/projetos-captados/7/geracoes/11/aprovar")
      expect(chamadas[0]!.body).toEqual({ decisao: "approve" })
    })
  })

  it("Editar permite mudar título/escopo/aceite/dependências/ordem e Salvar e aprovar envia planoEditado integral", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-editar"))

    // Editar título, escopo, aceite e dependências da tarefa 1 (índice 0)
    await user.clear(textboxDe("edit-titulo-0"))
    await user.type(textboxDe("edit-titulo-0"), "CRUD de Cliente v2")
    await user.clear(textboxDe("edit-escopo-0"))
    await user.type(textboxDe("edit-escopo-0"), "schema + tela + relatorio")
    await user.clear(textboxDe("edit-aceite-0"))
    await user.type(textboxDe("edit-aceite-0"), "tela lista clientes{enter}novo aceite")
    await user.clear(textboxDe("edit-depende-1"))
    await user.type(textboxDe("edit-depende-1"), "1")

    // Reordenar: mover a tarefa 2 (índice 1) para cima
    await user.click(screen.getByTestId("mover-cima-1"))

    await user.click(screen.getByTestId("btn-salvar-aprovar"))
    await waitFor(() => {
      const chamadas = chamadasAprovar()
      expect(chamadas.length).toBe(1)
      const body = chamadas[0]!.body
      expect(body.decisao).toBe("approve")
      const plano = body.planoEditado as Record<string, unknown>
      expect(plano).toBeDefined()
      expect(plano.kind).toBe("plano")
      // Plano integral: seções não editadas preservadas
      expect(plano.classificacaoSistema).toBe("misto")
      expect(plano.requisitos).toEqual(planoCompleto.requisitos)
      expect(plano.matrizCobertura).toEqual(planoCompleto.matrizCobertura)
      expect(plano.foraDeFase).toEqual(planoCompleto.foraDeFase)
      // Tarefas modificadas e reordenadas (seq renumerado 1..n)
      const tarefas = plano.tarefas as Array<Record<string, unknown>>
      expect(tarefas).toHaveLength(2)
      expect(tarefas[0]!.titulo).toBe("Integração gateway")
      expect(tarefas[0]!.seq).toBe(1)
      expect(tarefas[1]!.titulo).toBe("CRUD de Cliente v2")
      expect(tarefas[1]!.seq).toBe(2)
      expect(tarefas[1]!.escopo).toBe("schema + tela + relatorio")
      expect(tarefas[1]!.aceite).toEqual(["tela lista clientes", "novo aceite"])
      // depende_de da ex-tarefa 2 (agora seq 1) foi remapeado: [1] → [] seria inválido;
      // a referência antiga 1 (CRUD, agora seq 2) foi remapeada para 2
      expect(tarefas[0]!.depende_de).toEqual([2])
    })
  })

  it("Pedir revisão exige comentário e POSTa decisao=revise com o comentário", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-revisar"))

    // Sem comentário → não POSTa e mostra erro no dialog
    await user.click(screen.getByTestId("dialog-confirmar"))
    expect(chamadasAprovar()).toHaveLength(0)
    expect(screen.getByTestId("dialog-comentario")).toBeInTheDocument()

    await user.type(textboxDe("dialog-comentario"), "Falta detalhar o escopo do gateway")
    await user.click(screen.getByTestId("dialog-confirmar"))
    await waitFor(() => {
      const chamadas = chamadasAprovar()
      expect(chamadas.length).toBe(1)
      expect(chamadas[0]!.body).toEqual({
        decisao: "revise",
        comentario: "Falta detalhar o escopo do gateway",
      })
    })
  })

  it("Rejeitar POSTa decisao=reject com comentário opcional", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-rejeitar"))
    await user.type(textboxDe("dialog-comentario"), "Plano fora do escopo")
    await user.click(screen.getByTestId("dialog-confirmar"))
    await waitFor(() => {
      const chamadas = chamadasAprovar()
      expect(chamadas.length).toBe(1)
      expect(chamadas[0]!.body).toEqual({
        decisao: "reject",
        comentario: "Plano fora do escopo",
      })
    })
  })

  it("Rejeitar sem comentário POSTa apenas decisao=reject", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-rejeitar"))
    await user.click(screen.getByTestId("dialog-confirmar"))
    await waitFor(() => {
      const chamadas = chamadasAprovar()
      expect(chamadas.length).toBe(1)
      expect(chamadas[0]!.body).toEqual({ decisao: "reject" })
    })
  })

  it("erro 422 de plano inválido é exibido em Alert sem quebrar a tela", async () => {
    aprovarDeveFalhar = true
    aprovarStatus = 422
    const user = userEvent.setup()
    await renderizar()
    await user.click(screen.getByTestId("btn-aprovar"))
    await waitFor(() => {
      expect(screen.getByTestId("erro-decisao")).toHaveTextContent(
        "Plano macro inválido: tarefas com seq duplicado",
      )
    })
    // A tela segue renderizada (plano e decisões continuam visíveis)
    expect(screen.getByTestId("plano-projeto-screen")).toBeInTheDocument()
    expect(screen.getByTestId("secao-tarefas")).toHaveTextContent("CRUD de Cliente")
    expect(screen.getByTestId("btn-aprovar")).toBeEnabled()
  })

  it("chat: envia resposta via POST role=user e recarrega", async () => {
    const user = userEvent.setup()
    await renderizar()
    await user.type(textboxDe("chat-input"), "Prazo: dezembro")
    await user.click(screen.getByTestId("chat-enviar"))
    await waitFor(() => {
      const chamada = mockRequest.mock.calls.find(
        ([m, p]) => m === "POST" && String(p).endsWith("/projetos-captados/7/chat"),
      )
      expect(chamada).toBeDefined()
      expect((chamada![2] as { body?: unknown }).body).toEqual({
        role: "user",
        texto: "Prazo: dezembro",
      })
    })
    // Recarregou as gerações após o envio
    await waitFor(() => {
      const gets = mockRequest.mock.calls.filter(([m, p]) => m === "GET" && String(p).endsWith("/geracoes"))
      expect(gets.length).toBeGreaterThanOrEqual(2)
    })
  })

  it("sem contexto de linha (parentRow ausente) mostra orientação sem crash", () => {
    render(<PlanoProjetoScreen />)
    expect(screen.getByTestId("sem-projeto")).toBeInTheDocument()
    expect(chamadasAprovar()).toHaveLength(0)
  })
})
