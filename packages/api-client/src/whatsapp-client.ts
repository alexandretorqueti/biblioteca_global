import type {
  IniciarPareamentoWhatsappResponse,
  ListarVinculosWhatsappResponse,
  RemoverVinculoWhatsappResponse,
  StatusPareamentoWhatsappResponse,
} from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export class WhatsappChannelsClient {
  constructor(private readonly http: ApiHttpClient) {}

  startPairing(tenantId: number, accountId: string): Promise<IniciarPareamentoWhatsappResponse> {
    return this.http.request("POST", `/tenants/${tenantId}/whatsapp/pairing`, {
      body: { accountId },
      auth: "access",
    })
  }

  getPairingStatus(tenantId: number, accountId: string): Promise<StatusPareamentoWhatsappResponse> {
    return this.http.request("GET", `/tenants/${tenantId}/whatsapp/pairing/${encodeURIComponent(accountId)}`, {
      auth: "access",
    })
  }

  list(tenantId: number): Promise<ListarVinculosWhatsappResponse> {
    return this.http.request("GET", `/tenants/${tenantId}/whatsapp`, { auth: "access" })
  }

  remove(tenantId: number, accountId: string): Promise<RemoverVinculoWhatsappResponse> {
    return this.http.request("DELETE", `/tenants/${tenantId}/whatsapp/${encodeURIComponent(accountId)}`, {
      auth: "access",
    })
  }
}

export function createWhatsappChannelsClient(http: ApiHttpClient): WhatsappChannelsClient {
  return new WhatsappChannelsClient(http)
}
