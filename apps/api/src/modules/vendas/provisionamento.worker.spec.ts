// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ProvisionamentoWorker } from "./provisionamento.worker"

const now = new Date("2026-11-18T12:00:00.000Z")
function context(status: "paid" | "aguardando_aceite" | "provisioned" = "paid") {
  return {
    outbox: { id: 1, assinaturaId: 9, tentativas: 1 },
    pedido: { id: 3, status, welcomeEmailSent: false, payloadSnapshot: { contato: { email: "ana@example.com" }, transbordo: { ativo: false } } },
    assinatura: { id: 9 },
    negocio: { id: 4, nome: "Padaria Alpha", segmentoDescricao: "Venda de pães e atendimento ao cliente", contato: { email: "ana@example.com" }, transbordo: { ativo: false } },
    plano: { slug: "starter", limitesCotas: { mensagens: 100 } },
    documentos: [],
  }
}

function setup(overrides: Record<string, unknown> = {}) {
  const repository = {
    listarParaRetry: vi.fn().mockResolvedValue([]), claim: vi.fn().mockResolvedValue({ id: 1, assinaturaId: 9, tentativas: 1 }), concluir: vi.fn(), falhar: vi.fn(), tornarDead: vi.fn(), contexto: vi.fn().mockResolvedValue(context()), marcarPedido: vi.fn(), criarOuObterTenant: vi.fn().mockResolvedValue({ id: 10, slug: "padaria-alpha-4" }), vincularAssinatura: vi.fn(), marcarEmailEnviado: vi.fn(), aprovarAceite: vi.fn(), rejeitarAceite: vi.fn(), marcarReembolsavel: vi.fn(), marcarNegocio: vi.fn(), ...overrides,
  }
  const env = { vendasAceiteManual: false }
  const forjador = { forjarPersona: vi.fn().mockResolvedValue({ personaId: 20, versao: 1, soul: "soul", identity: "identity", agents: "agents", status: "completed" }) }
  const email = { sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true }) }
  const alert = { send: vi.fn().mockResolvedValue(undefined) }
  const worker = new ProvisionamentoWorker(repository as never, env as never, forjador as never, email as never, alert, { now: () => now, intervalMs: 999999 })
  return { worker, repository, forjador, email, alert }
}

describe("ProvisionamentoWorker", () => {
  it("forja, cria tenant, vincula assinatura e envia boas-vindas", async () => {
    const { worker, repository, forjador, email } = setup()
    await worker.processOne(1)
    expect(forjador.forjarPersona).toHaveBeenCalledOnce()
    expect(repository.criarOuObterTenant).toHaveBeenCalledOnce()
    expect(repository.vincularAssinatura).toHaveBeenCalledWith(9, 10, "padaria-alpha-4")
    expect(email.sendWelcomeEmail).toHaveBeenCalledOnce()
    expect(repository.concluir).toHaveBeenCalledWith(1)
  })

  it("segura no aceite manual e retoma após aprovação", async () => {
    const { worker, repository, alert } = setup()
    const env = (worker as unknown as { env: { vendasAceiteManual: boolean } }).env
    env.vendasAceiteManual = true
    await worker.processOne(1)
    expect(repository.marcarPedido).toHaveBeenCalledWith(3, "aguardando_aceite")
    expect(repository.falhar).toHaveBeenCalled()
    expect(alert.send).toHaveBeenCalledWith(expect.stringContaining("aguardando aceite"))
  })

  it("marca reembolsável, dead e alerta no limite", async () => {
    const { worker, repository, alert, forjador } = setup({ claim: vi.fn().mockResolvedValue({ id: 1, assinaturaId: 9, tentativas: 5 }) })
    forjador.forjarPersona.mockRejectedValue(new Error("forjador indisponível"))
    await worker.processOne(1)
    expect(repository.tornarDead).toHaveBeenCalledWith(1)
    expect(repository.marcarReembolsavel).toHaveBeenCalledWith(9)
    expect(alert.send).toHaveBeenCalledWith(expect.stringContaining("reembolsável"))
  })

  it("reagenda falha transitória com backoff", async () => {
    const { worker, repository, forjador } = setup({ claim: vi.fn().mockResolvedValue({ id: 1, assinaturaId: 9, tentativas: 2 }) })
    forjador.forjarPersona.mockRejectedValue(new Error("temporário"))
    await worker.processOne(1)
    expect(repository.falhar).toHaveBeenCalledWith(1, "temporário", new Date(now.getTime() + 120_000))
    expect(repository.tornarDead).not.toHaveBeenCalled()
  })

  it("não repete persona nem e-mail para pedido já provisionado", async () => {
    const { worker, repository, forjador, email } = setup({ contexto: vi.fn().mockResolvedValue(context("provisioned")) })
    await worker.processOne(1)
    expect(forjador.forjarPersona).not.toHaveBeenCalled()
    expect(email.sendWelcomeEmail).not.toHaveBeenCalled()
    expect(repository.concluir).toHaveBeenCalledWith(1)
  })
})
