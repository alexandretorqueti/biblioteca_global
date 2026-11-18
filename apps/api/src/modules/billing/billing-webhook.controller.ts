import { BadRequestException, Controller, Headers, HttpCode, Inject, Post, Req } from "@nestjs/common"
import type { Request } from "express"
import { BillingService } from "./billing.service"
import { PSP_BILLING_GATEWAY, type PspBillingGateway } from "./psp-billing.gateway"

interface RawBodyRequest extends Request {
  rawBody?: Buffer
}

/** Endpoint público do PSP: autenticação é a assinatura HMAC, não JWT. */
@Controller("billing")
export class BillingWebhookController {
  constructor(
    private readonly service: BillingService,
    @Inject(PSP_BILLING_GATEWAY) private readonly psp: PspBillingGateway,
  ) {}

  @Post("webhook")
  @HttpCode(200)
  async receber(
    @Req() request: RawBodyRequest,
    @Headers("x-signature") signature?: string,
    @Headers("x-request-id") requestId?: string,
  ): Promise<{ received: true; duplicate?: boolean }> {
    const rawBody = request.rawBody?.toString("utf8")
    if (!rawBody) throw new BadRequestException("Corpo bruto ausente")

    let payload: unknown
    try {
      payload = JSON.parse(rawBody) as unknown
    } catch {
      throw new BadRequestException("JSON inválido")
    }
    const dataId = this.service.webhookDataId(payload)
    if (!dataId || !this.psp.validateWebhookSignature({ rawBody, dataId, requestId, signature })) {
      throw new BadRequestException("Assinatura de webhook inválida")
    }
    const result = await this.service.receberWebhook(payload)
    return result.duplicate ? { received: true, duplicate: true } : { received: true }
  }
}
