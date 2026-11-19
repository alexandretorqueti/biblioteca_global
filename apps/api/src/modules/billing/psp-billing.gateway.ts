/** Contrato mínimo do provedor de cobrança. Dados de pagamento nunca passam por aqui. */
export const PSP_BILLING_GATEWAY = Symbol("PSP_BILLING_GATEWAY")

export type BillingCycle = "monthly" | "yearly"

export interface BillingCustomerInput {
  externalReference: string
  name: string
  email: string
}

export interface BillingCustomer {
  id: string
}

export interface BillingSubscriptionInput {
  externalReference: string
  customerId: string
  planName: string
  amountInCents: number
  currency: string
  cycle: BillingCycle
  payerEmail: string
  checkoutSuccessUrl: string
  checkoutFailureUrl: string
  checkoutPendingUrl: string
}

export interface BillingCheckout {
  subscriptionId: string
  checkoutUrl: string
}

export interface BillingSubscriptionState {
  id: string
  status: string
}

export interface BillingPayment {
  id: string
  status: string
  externalReference?: string
  metadata?: Record<string, unknown>
}

export interface WebhookSignatureInput {
  signature?: string
  requestId?: string
  dataId?: string
  rawBody: string
}

export interface PspBillingGateway {
  createCustomer(input: BillingCustomerInput): Promise<BillingCustomer>
  createSubscription(input: BillingSubscriptionInput): Promise<BillingCheckout>
  getSubscription(subscriptionId: string): Promise<BillingSubscriptionState>
  getPayment(paymentId: string): Promise<BillingPayment>
  validateWebhookSignature(input: WebhookSignatureInput): boolean
}
