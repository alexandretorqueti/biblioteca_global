import { Injectable } from "@nestjs/common"
import { createHmac, timingSafeEqual } from "node:crypto"
import { EnvService } from "../../config/env.service"
import type {
  BillingCheckout,
  BillingCustomer,
  BillingCustomerInput,
  BillingPayment,
  BillingSubscriptionInput,
  BillingSubscriptionState,
  PspBillingGateway,
  WebhookSignatureInput,
} from "./psp-billing.gateway"

interface MercadoPagoResponse {
  id?: string | number
  init_point?: string
  sandbox_init_point?: string
  status?: string
  external_reference?: string
  metadata?: unknown
}

/** Adaptador Mercado Pago usando somente fetch nativo e checkout hospedado. */
@Injectable()
export class MercadoPagoAdapter implements PspBillingGateway {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly env: EnvService) {
    this.baseUrl = env.pspApiUrl.replace(/\/$/, "")
    this.timeoutMs = env.pspTimeoutMs
  }

  async createCustomer(input: BillingCustomerInput): Promise<BillingCustomer> {
    const response = await this.request("/v1/customers", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        ...this.customerName(input.name),
        external_reference: input.externalReference,
      }),
    })
    const data = await this.readJson(response)
    const id = this.stringId(data.id)
    if (!id) throw new Error("Mercado Pago não retornou o customer_id")
    return { id }
  }

  async createSubscription(input: BillingSubscriptionInput): Promise<BillingCheckout> {
    // A preferência hospedada aceita cartão, PIX e boleto. A recorrência é
    // representada pela referência/ciclo e confirmada pelo fluxo de billing.
    const response = await this.request("/checkout/preferences", {
      method: "POST",
      body: JSON.stringify({
        external_reference: input.externalReference,
        payer: { email: input.payerEmail },
        items: [{
          id: input.externalReference,
          title: input.planName,
          quantity: 1,
          unit_price: input.amountInCents / 100,
          currency_id: input.currency,
        }],
        payment_methods: {
          excluded_payment_types: [],
          installments: 12,
        },
        back_urls: {
          success: input.checkoutSuccessUrl,
          failure: input.checkoutFailureUrl,
          pending: input.checkoutPendingUrl,
        },
        auto_return: "approved",
        metadata: {
          customer_id: input.customerId,
          cycle: input.cycle,
        },
      }),
    })
    const data = await this.readJson(response)
    const id = this.stringId(data.id)
    const checkoutUrl = data.init_point ?? data.sandbox_init_point
    if (!id || typeof checkoutUrl !== "string" || checkoutUrl.length === 0) {
      throw new Error("Mercado Pago não retornou checkout hospedado")
    }
    return { subscriptionId: id, checkoutUrl }
  }

  async getSubscription(subscriptionId: string): Promise<BillingSubscriptionState> {
    const response = await this.request(`/checkout/preferences/${encodeURIComponent(subscriptionId)}`, {
      method: "GET",
    })
    const data = await this.readJson(response)
    const id = this.stringId(data.id)
    if (!id || typeof data.status !== "string") {
      throw new Error("Mercado Pago retornou assinatura inválida")
    }
    return { id, status: data.status }
  }

  async getPayment(paymentId: string): Promise<BillingPayment> {
    const response = await this.request(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
    })
    const data = await this.readJson(response)
    const id = this.stringId(data.id)
    if (!id || typeof data.status !== "string") {
      throw new Error("Mercado Pago retornou pagamento inválido")
    }
    return {
      id,
      status: data.status,
      ...(typeof data.external_reference === "string" ? { externalReference: data.external_reference } : {}),
      ...(this.isRecord(data.metadata) ? { metadata: data.metadata } : {}),
    }
  }

  validateWebhookSignature(input: WebhookSignatureInput): boolean {
    const signature = input.signature
    if (!signature || !input.requestId || !input.dataId) return false
    const parts = new Map(
      signature.split(",").map((part) => {
        const [key, ...value] = part.trim().split("=")
        return [key, value.join("=")] as const
      }),
    )
    const timestamp = parts.get("ts")
    const received = parts.get("v1")
    if (!timestamp || !received || !/^\d+$/.test(timestamp)) return false
    const manifest = `id:${input.dataId};request-id:${input.requestId};ts:${timestamp};`
    const expected = createHmac("sha256", this.env.pspWebhookSecret)
      .update(manifest)
      .digest("hex")
    const expectedBuffer = Buffer.from(expected, "utf8")
    const receivedBuffer = Buffer.from(received, "utf8")
    return expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.env.pspAccessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      })
      if (!response.ok) {
        throw new Error(`Mercado Pago respondeu HTTP ${response.status}`)
      }
      return response
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readJson(response: Response): Promise<MercadoPagoResponse> {
    const value: unknown = await response.json()
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Resposta inválida do Mercado Pago")
    }
    return value as MercadoPagoResponse
  }

  private customerName(name: string): { first_name: string; last_name?: string } {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    const firstName = parts.shift() ?? name.trim()
    return parts.length > 0
      ? { first_name: firstName, last_name: parts.join(" ") }
      : { first_name: firstName }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  private stringId(value: string | number | undefined): string | undefined {
    return typeof value === "string" && value.length > 0
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined
  }
}
