// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { BillingService } from "./billing.service"

const webhookEvent = (payload: unknown, tipo = "payment.updated") => ({
  id: 1, dedupeKey: "payment:pay-1", tipo, payload,
  status: "pending" as const, tentativas: 0, proximaTentativaEm: null,
  createdAt: new Date(), updatedAt: new Date(),
})

function setup(payload: unknown) {
  const event = webhookEvent(payload)
  const repository = {
    inserirWebhook: vi.fn().mockResolvedValue({ event, duplicate: false }),
    claimWebhook: vi.fn().mockResolvedValue(undefined),
    processarAprovacao: vi.fn().mockResolvedValue(undefined),
    marcarWebhookConcluido: vi.fn().mockResolvedValue(undefined),
    marcarWebhookFalho: vi.fn().mockResolvedValue(undefined),
  }
  const gateway = { getPayment: vi.fn() }
  return { service: new BillingService(repository as never, gateway as never), repository, gateway }
}

describe("BillingService webhook de pagamento", () => {
  it("normaliza type+action, busca pagamento real e ativa pela external_reference", async () => {
    const { service, repository, gateway } = setup({
      type: "payment", action: "payment.updated", data: { id: "pay-1" },
    })
    gateway.getPayment.mockResolvedValue({
      id: "pay-1", status: "approved", externalReference: "assinatura:42",
    })

    const result = await service.receberWebhook({
      type: "payment", action: "payment.updated", data: { id: "pay-1" },
    })
    repository.claimWebhook.mockResolvedValue(webhookEvent({
      type: "payment", action: "payment.updated", data: { id: "pay-1" },
    }))
    await service.processarWebhook(webhookEvent({ type: "payment", action: "payment.updated", data: { id: "pay-1" } }))

    expect(result).toEqual({ duplicate: false })
    expect(repository.inserirWebhook).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "payment.updated:pay-1", tipo: "payment.updated",
    }))
    expect(gateway.getPayment).toHaveBeenCalledWith("pay-1")
    expect(repository.processarAprovacao).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "42" }))
  })

  it("não ativa pagamento com status diferente de approved", async () => {
    const { service, repository, gateway } = setup({
      type: "payment", action: "payment.updated", data: { id: "pay-1", status: "pending" },
    })
    repository.claimWebhook.mockResolvedValue(webhookEvent({
      type: "payment", action: "payment.updated", data: { id: "pay-1", status: "pending" },
    }))
    await service.processarWebhook(webhookEvent({
      type: "payment", action: "payment.updated", data: { id: "pay-1", status: "pending" },
    }))

    expect(gateway.getPayment).not.toHaveBeenCalled()
    expect(repository.processarAprovacao).not.toHaveBeenCalled()
    expect(repository.marcarWebhookConcluido).toHaveBeenCalledWith(1)
  })

  it("preserva duplicate:false no primeiro recebimento e duplicate:true no reenvio", async () => {
    const payload = { type: "payment", action: "payment.updated", data: { id: "pay-1" } }
    const { service, repository } = setup(payload)
    repository.inserirWebhook.mockResolvedValueOnce({ event: webhookEvent(payload), duplicate: false })
      .mockResolvedValueOnce({ event: webhookEvent(payload), duplicate: true })

    await expect(service.receberWebhook(payload)).resolves.toEqual({ duplicate: false })
    await expect(service.receberWebhook(payload)).resolves.toEqual({ duplicate: true })
  })
})
