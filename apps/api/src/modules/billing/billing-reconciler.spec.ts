// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { BillingReconciler, BillingTelegramAlertSender } from "./billing-reconciler"

const now = new Date("2026-11-18T12:00:00.000Z")
const event = (tentativas: number) => ({
  id: 7, dedupeKey: "payment:7", tipo: "payment.approved", payload: { subscription_id: "sub-7" },
  status: "failed" as const, tentativas, proximaTentativaEm: now, createdAt: now, updatedAt: now,
})

function setup(input: { events?: ReturnType<typeof event>[]; process?: (webhookEvent: ReturnType<typeof event>) => Promise<void> } = {}) {
  const repository = {
    listarWebhooksParaRetry: vi.fn().mockResolvedValue(input.events ?? []),
    listarAssinaturasPendentesAntigas: vi.fn().mockResolvedValue([]),
    marcarWebhookFalho: vi.fn().mockResolvedValue(undefined),
    marcarWebhookDead: vi.fn().mockResolvedValue(undefined),
    marcarAssinaturaReembolsavel: vi.fn().mockResolvedValue(undefined),
    sincronizarAssinaturaPsp: vi.fn().mockResolvedValue(undefined),
  }
  const gateway = { getSubscription: vi.fn() }
  const service = {
    processarWebhook: input.process ?? vi.fn().mockResolvedValue(undefined),
    subscriptionIdFromPayload: vi.fn().mockReturnValue("sub-7"),
  }
  const alertSender = { send: vi.fn().mockResolvedValue(undefined) }
  const reconciler = new BillingReconciler(repository as never, gateway as never, service as never, alertSender, {
    now: () => now, maxAttempts: 5, pendingAgeMs: 1, batchSize: 10,
  })
  return { reconciler, repository, gateway, service, alertSender }
}

afterEach(() => vi.restoreAllMocks())

describe("BillingReconciler", () => {
  it("aplica backoff crescente e continua após erro individual", async () => {
    const first = event(1)
    const second = { ...event(1), id: 8, payload: { subscription_id: "sub-8" } }
    const process = vi.fn()
      .mockRejectedValueOnce(new Error("transitório"))
      .mockResolvedValueOnce(undefined)
    const { reconciler, repository, service } = setup({ events: [first, second], process })

    await reconciler.reconcile()

    expect(service.processarWebhook).toHaveBeenCalledTimes(2)
    expect(repository.marcarWebhookFalho).toHaveBeenCalledWith(first.id, "transitório", new Date(now.getTime() + 120_000))
    expect(repository.marcarWebhookDead).not.toHaveBeenCalled()
  })

  it("esgotado vira dead, marca reembolsável e alerta", async () => {
    const { reconciler, repository, alertSender } = setup({
      events: [event(4)], process: vi.fn().mockRejectedValue(new Error("provisionamento indisponível")),
    })

    await reconciler.reconcile()

    expect(repository.marcarWebhookDead).toHaveBeenCalledWith(7)
    expect(repository.marcarAssinaturaReembolsavel).toHaveBeenCalledWith("sub-7")
    expect(alertSender.send).toHaveBeenCalledWith(expect.stringContaining("reembolsável"))
  })

  it("consulta o PSP e converge assinatura pendente sem webhook", async () => {
    const pending = { id: 9, pspSubscriptionId: "sub-9" }
    const { reconciler, repository, gateway } = setup()
    repository.listarAssinaturasPendentesAntigas.mockResolvedValue([pending])
    gateway.getSubscription.mockResolvedValue({ id: "sub-9", status: "active" })

    await reconciler.reconcile()

    expect(gateway.getSubscription).toHaveBeenCalledWith("sub-9")
    expect(repository.sincronizarAssinaturaPsp).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId: "sub-9", status: "active",
    }))
  })

  it("alerta Telegram usa HTTPS direto e ausência de configuração é log-only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    await new BillingTelegramAlertSender("bot", "chat", fetchMock).send("billing dead")
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/botbot/sendMessage", expect.objectContaining({ method: "POST" }))

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await new BillingTelegramAlertSender(undefined, undefined, fetchMock).send("log-only")
    expect(warn).toHaveBeenCalled()
  })
})
