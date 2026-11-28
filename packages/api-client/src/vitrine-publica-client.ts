/**
 * VitrinePublicaClient (macro #10, posições 2/11 e 3/11 — subtarefas 2 e 3).
 *
 * Cliente público da vitrine: consome `GET /api/vitrine/conteudo` e as
 * rotas de pedido (`POST /api/vitrine/pedidos` multipart, criação
 * autoatendida; `GET /api/vitrine/pedidos/:token`, acompanhamento) — todas
 * `@Public()` da API, SEM token: `auth: "none"`, mesmo precedente de
 * `TenantsChatClient`. A UI nunca faz fetch cru: o transporte passa pelo
 * ApiHttpClient e a resposta é validada contra os contratos Zod-first
 * (`vitrinePublicaConteudoSchema`, `vitrinePedidoCriacaoRespostaSchema`,
 * `vitrinePedidoAcompanhamentoSchema`) antes de chegar à tela — resposta
 * fora do contrato vira erro explícito (estados honestos), nunca dado
 * inventado. O multipart de criação espelha exatamente o contrato do
 * backend (subtarefa 1): campo `dados` = JSON string do
 * `VitrinePedidoDados`, campo `textoLivre` (só quando não vazio) e N
 * arquivos no campo `arquivos`; nenhum `Content-Type` manual — o browser
 * define o boundary do FormData.
 */
import {
  vitrinePedidoAcompanhamentoSchema,
  vitrinePedidoCriacaoRespostaSchema,
  vitrinePublicaConteudoSchema,
  type VitrinePedidoAcompanhamento,
  type VitrinePedidoCriacaoResposta,
  type VitrinePedidoDados,
  type VitrinePublicaConteudo,
} from "@biblioteca-global/shared"
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

/** Payload da criação pública do pedido (multipart montado pelo cliente). */
export interface VitrinePedidoCriacaoInput {
  /**
   * Dados do pedido no contrato strict — o tipo já exige
   * `consentimentoLgpd: true` (sem aceite não há envio) e proíbe campos de
   * fluxo; a autoridade de validação continua server-side.
   */
  dados: VitrinePedidoDados
  /** Arquivos de conhecimento (.pdf/.docx/.txt) no campo `arquivos`. */
  arquivos?: readonly File[]
  /** Texto livre (vira documento `texto_livre` no backend); vazio não sai. */
  textoLivre?: string
}

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

  /**
   * Cria pedido público (POST multipart, auth "none") e devolve SOMENTE o
   * contrato de confirmação (`vitrinePedidoCriacaoRespostaSchema`). Erros
   * 400 do backend (validação strict, upload, plano inativo) chegam como
   * `ApiClientError` com a mensagem clara do servidor.
   */
  async criarPedido(
    input: VitrinePedidoCriacaoInput,
  ): Promise<VitrinePedidoCriacaoResposta> {
    const form = new FormData()
    form.append("dados", JSON.stringify(input.dados))
    if (input.textoLivre !== undefined && input.textoLivre.trim() !== "") {
      form.append("textoLivre", input.textoLivre)
    }
    for (const arquivo of input.arquivos ?? []) {
      form.append("arquivos", arquivo, arquivo.name)
    }
    const dados = await this.http.request<unknown>("POST", "/vitrine/pedidos", {
      body: form,
      auth: "none",
    })
    const resultado = vitrinePedidoCriacaoRespostaSchema.safeParse(dados)
    if (!resultado.success) {
      throw new ApiClientError(
        500,
        "INVALID_RESPONSE",
        "Resposta inválida na criação do pedido da vitrine",
        resultado.error.issues,
      )
    }
    return resultado.data
  }

  /**
   * Acompanhamento do pedido pelo token de acompanhamento (GET, auth
   * "none"). Resposta fora do contrato vira erro explícito; 404 (token
   * inválido/inexistente) chega como `ApiClientError` com status 404.
   */
  async obterPedidoPorToken(
    token: string,
  ): Promise<VitrinePedidoAcompanhamento> {
    const dados = await this.http.request<unknown>(
      "GET",
      `/vitrine/pedidos/${encodeURIComponent(token)}`,
      { auth: "none" },
    )
    const resultado = vitrinePedidoAcompanhamentoSchema.safeParse(dados)
    if (!resultado.success) {
      throw new ApiClientError(
        500,
        "INVALID_RESPONSE",
        "Resposta inválida no acompanhamento do pedido da vitrine",
        resultado.error.issues,
      )
    }
    return resultado.data
  }
}

export function createVitrinePublicaClient(http: ApiHttpClient): VitrinePublicaClient {
  return new VitrinePublicaClient(http)
}
