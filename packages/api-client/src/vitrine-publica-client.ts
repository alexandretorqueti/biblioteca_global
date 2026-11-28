/**
 * VitrinePublicaClient (macro #10, posição 2/11 — subtarefa 2).
 *
 * Cliente público da vitrine: consome `GET /api/vitrine/conteudo` (rota
 * `@Public()` da subtarefa 1) SEM token — `auth: "none"`, mesmo precedente
 * de `TenantsChatClient`. A UI nunca faz fetch cru: o transporte passa pelo
 * ApiHttpClient e a resposta é validada contra o contrato Zod-first
 * `vitrinePublicaConteudoSchema` antes de chegar à tela — resposta fora do
 * contrato vira erro explícito (estados honestos), nunca dado inventado.
 */
import { vitrinePublicaConteudoSchema, type VitrinePublicaConteudo } from "@biblioteca-global/shared"
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

export class VitrinePublicaClient {
  constructor(private readonly http: ApiHttpClient) {}

  /** Conteúdo ativo da vitrine (planos, FAQ, métricas, segmentos, textos). */
  async obterConteudo(): Promise<VitrinePublicaConteudo> {
    const dados = await this.http.request<unknown>("GET", "/vitrine/conteudo", {
      auth: "none",
    })
    const resultado = vitrinePublicaConteudoSchema.safeParse(dados)
    if (!resultado.success) {
      throw new ApiClientError(
        500,
        "INVALID_RESPONSE",
        "Resposta inválida do endpoint público da vitrine",
        resultado.error.issues,
      )
    }
    return resultado.data
  }
}

export function createVitrinePublicaClient(http: ApiHttpClient): VitrinePublicaClient {
  return new VitrinePublicaClient(http)
}
