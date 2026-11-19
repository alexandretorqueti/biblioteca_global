// @vitest-environment node
import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MercadoPagoAdapter } from "./mercado-pago.adapter"
import type { EnvService } from "../../config/env.service"

const env = {
  pspApiUrl: "https://api.mercadopago.test",
  pspAccessToken: "access-token",
  pspWebhookSecret: "webhook-secret",
  pspTimeoutMs: 1000,
} as EnvService

afterEach(() => vi.restoreAllMocks())

describe("MercadoPagoAdapter", () => {
  it("cria customer e checkout sem enviar dados sensíveis de pagamento", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cus-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pref-1", init_point: "https://mp.test/checkout" }), { status: 201 }))
    const adapter = new MercadoPagoAdapter(env)

    const customer = await adapter.createCustomer({ externalReference: "tenant:t1", name: "Ana", email: "ana@example.com" })
    const checkout = await adapter.createSubscription({
      externalReference: "assinatura:1",
      customerId: customer.id,
      planName: "Pro",
      amountInCents: 9900,
      currency: "BRL",
      cycle: "monthly",
      payerEmail: "ana@example.com",
      checkoutSuccessUrl: "https://app.test/sucesso",
      checkoutFailureUrl: "https://app.test/falha",
      checkoutPendingUrl: "https://app.test/pendente",
    })

    expect(checkout).toEqual({ subscriptionId: "pref-1", checkoutUrl: "https://mp.test/checkout" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const sentBody = String(fetchMock.mock.calls[1]?.[1]?.body)
    expect(sentBody).not.toMatch(/number|cvv|security_code|expiration/i)
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.mercadopago.test/checkout/preferences")
  })

  it("divide nome composto em first_name e last_name e busca pagamento por id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cus-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "pay-1", status: "approved", external_reference: "assinatura:7",
        metadata: { subscription_id: "7" },
      }), { status: 200 }))
    const adapter = new MercadoPagoAdapter(env)

    await adapter.createCustomer({ externalReference: "tenant:t1", name: "Ana Maria Silva", email: "ana@example.com" })
    const payment = await adapter.getPayment("pay-1")

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      first_name: "Ana", last_name: "Maria Silva",
    })
    expect(payment).toEqual({
      id: "pay-1", status: "approved", externalReference: "assinatura:7",
      metadata: { subscription_id: "7" },
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.mercadopago.test/v1/payments/pay-1")
  })

  it("não envia last_name para nome de uma palavra", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cus-1" }), { status: 201 }))
    const adapter = new MercadoPagoAdapter(env)

    await adapter.createCustomer({ externalReference: "tenant:t1", name: "Ana", email: "ana@example.com" })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "ana@example.com", first_name: "Ana", external_reference: "tenant:t1",
    })
  })

  it.each([
    ["válida", true],
    ["ausente", false],
    ["inválida", false],
  ])("valida assinatura HMAC %s", (_name, valid) => {
    const adapter = new MercadoPagoAdapter(env)
    const dataId = "evt-1"
    const requestId = "request-1"
    const timestamp = "1730000000"
    const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`
    const signature = createHmac("sha256", env.pspWebhookSecret).update(manifest).digest("hex")
    const input = valid === true
      ? { rawBody: "{}", dataId, requestId, signature: `ts=${timestamp},v1=${signature}` }
      : _name === "ausente"
        ? { rawBody: "{}", dataId, requestId }
        : { rawBody: "{}", dataId, requestId, signature: `ts=${timestamp},v1=invalid` }
    expect(adapter.validateWebhookSignature(input)).toBe(valid)
  })

  it("aborta transporte quando o PSP excede o timeout", async () => {
    const adapter = new MercadoPagoAdapter({ ...env, pspTimeoutMs: 1 } as EnvService)
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    }))
    await expect(adapter.createCustomer({ externalReference: "tenant:t1", name: "Ana", email: "ana@example.com" }))
      .rejects.toThrow()
  })
})
