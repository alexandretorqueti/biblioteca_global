import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { EnvService } from "../../config/env.service"
import type { AnexarDocumentoDto } from "./dto/anexar-documento.dto"
import type { AnotarNegocioDto } from "./dto/anotar-negocio.dto"
import type { CriarPedidoDto } from "./dto/criar-pedido.dto"
import { VENDAS_REPOSITORY, type VendasRepository } from "./vendas.repository"
import { BillingService } from "../billing/billing.service"

export const MIME_DOCUMENTOS_NEGOCIO = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const

@Injectable()
export class VendasService {
  constructor(
    @Inject(VENDAS_REPOSITORY) private readonly repository: VendasRepository,
    private readonly env: EnvService,
    @Optional() private readonly billing?: BillingService,
  ) {}

  async anotarNegocio(dto: AnotarNegocioDto) {
    if (dto.transbordo.ativo && (!dto.transbordo.destinoNumero || !dto.transbordo.destinoNome)) {
      throw new BadRequestException("Transbordo ativo exige destinoNumero e destinoNome")
    }
    return this.repository.upsertNegocio({
      chatId: dto.chatId.trim(),
      nome: dto.nome.trim(),
      segmentoDescricao: dto.segmentoDescricao.trim(),
      contato: {
        nome: dto.contato.nome.trim(),
        email: dto.contato.email.trim().toLowerCase(),
        telefone: dto.contato.telefone.trim(),
      },
      transbordo: {
        ativo: dto.transbordo.ativo,
        destinoNumero: dto.transbordo.destinoNumero?.trim(),
        destinoNome: dto.transbordo.destinoNome?.trim(),
      },
    })
  }

  listarPlanos() {
    if (!this.billing) throw new Error("BillingService indisponível")
    return this.billing.listarPlanos().then((planos) => planos.map(({ slug, nome, precoCentavos, moeda, ciclo }) => ({
      slug, nome, precoCentavos, moeda, ciclo,
    })))
  }

  async anexarDocumento(dto: AnexarDocumentoDto) {
    if (!(MIME_DOCUMENTOS_NEGOCIO as readonly string[]).includes(dto.mime)) {
      throw new BadRequestException(`Mime não permitido. Aceitos: ${MIME_DOCUMENTOS_NEGOCIO.join(", ")}`)
    }
    const negocio = await this.repository.buscarNegocioPorChatId(dto.chatId.trim())
    if (!negocio) throw new NotFoundException("Negócio não encontrado para o chatId informado")

    const conteudo = Buffer.from(dto.conteudoBase64, "base64")
    if (conteudo.length > this.env.vendasDocumentosMaxBytes) {
      throw new BadRequestException(`Documento excede o limite de ${this.env.vendasDocumentosMaxBytes} bytes`)
    }
    const diretorio = this.env.vendasDocumentosDir
    await mkdir(diretorio, { recursive: true })
    const nomeSeguro = basename(dto.nome).replace(/[^a-zA-Z0-9._-]/g, "_")
    const caminho = join(diretorio, `${randomUUID()}-${nomeSeguro}`)
    await writeFile(caminho, conteudo, { flag: "wx" })
    try {
      return await this.repository.criarDocumento({
        negocioId: negocio.id,
        nome: dto.nome,
        mime: dto.mime,
        tamanho: conteudo.length,
        caminho,
      })
    } catch (error) {
      // Não deixar arquivo órfão se a persistência do metadado falhar.
      const { unlink } = await import("node:fs/promises")
      await unlink(caminho).catch(() => undefined)
      throw error
    }
  }

  /** Estado resumido usado pelo contexto conversacional da Isa. */
  async obterEstado(chatId: string) {
    const negocio = await this.repository.buscarNegocioPorChatId(chatId.trim())
    if (!negocio) return null

    const documentos = this.repository.listarDocumentos
      ? await this.repository.listarDocumentos(negocio.id)
      : []
    const pedido = this.repository.buscarPedidoPendente
      ? await this.repository.buscarPedidoPendente(negocio.id)
      : undefined

    return {
      nome: negocio.nome,
      segmentoDescricao: negocio.segmentoDescricao,
      contato: negocio.contato,
      transbordo: negocio.transbordo,
      status: negocio.status,
      documentos: documentos.map((documento) => ({
        nome: documento.nome,
        mime: documento.mime,
        tamanho: documento.tamanho,
      })),
      planoSlug: pedido?.planoSlug ?? null,
      pedidoStatus: pedido?.status ?? null,
    }
  }

  async criarPedido(dto: CriarPedidoDto) {
    const negocio = await this.repository.buscarNegocioPorChatId(dto.chatId.trim())
    if (!negocio) throw new NotFoundException("Negócio não encontrado para o chatId informado")
    if (!negocio.nome.trim() || !negocio.segmentoDescricao.trim()) {
      throw new BadRequestException("Negócio incompleto")
    }
    const contato = this.asContato(negocio.contato)
    if (!contato?.nome || !contato.email || !contato.telefone) {
      throw new BadRequestException("Contato do negócio incompleto")
    }
    if (!this.billing) throw new Error("BillingService indisponível")
    const plano = await this.billing.buscarPlanoAtivo(dto.planoSlug)
    if (!plano) throw new BadRequestException("Plano ativo não encontrado")
    if (dto.ciclo !== undefined && dto.ciclo !== plano.ciclo) {
      throw new BadRequestException("Ciclo incompatível com o plano")
    }
    if (!this.repository.buscarPedidoPendente || !this.repository.criarPedido || !this.repository.vincularPedidoAssinatura) {
      throw new Error("Repositório de vendas sem suporte a pedidos")
    }
    const existente = await this.repository.buscarPedidoPendente(negocio.id)
    if (existente?.planoSlug === plano.slug && existente.checkoutUrl && existente.assinaturaId) {
      return { pedidoId: existente.id, assinaturaId: existente.assinaturaId, checkoutUrl: existente.checkoutUrl }
    }
    if (existente && this.repository.invalidarPedido) await this.repository.invalidarPedido(existente.id)
    const documentos = this.repository.listarDocumentos ? await this.repository.listarDocumentos(negocio.id) : []
    const snapshot = {
      negocio: { id: negocio.id, chatId: negocio.chatId, nome: negocio.nome, segmentoDescricao: negocio.segmentoDescricao },
      contato, transbordo: negocio.transbordo, documentos,
    }
    const pedido = await this.repository.criarPedido({ negocioId: negocio.id, planoSlug: plano.slug, payloadSnapshot: snapshot })
    const assinatura = await this.billing.criarAssinaturaParaLead({
      tenantSlugProvisorio: `lead-${negocio.id}`,
      nome: contato.nome,
      email: contato.email,
      planoSlug: plano.slug,
      ciclo: dto.ciclo,
      checkoutSuccessUrl: dto.checkoutSuccessUrl,
      checkoutFailureUrl: dto.checkoutFailureUrl,
      checkoutPendingUrl: dto.checkoutPendingUrl,
    })
    const vinculado = await this.repository.vincularPedidoAssinatura(pedido.id, assinatura.id, assinatura.checkoutUrl)
    if (this.repository.atualizarStatusNegocio) await this.repository.atualizarStatusNegocio(negocio.id, "checkout")
    return { pedidoId: vinculado.id, assinaturaId: assinatura.id, checkoutUrl: assinatura.checkoutUrl }
  }

  private asContato(value: unknown): { nome: string; email: string; telefone: string } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    return typeof candidate.nome === "string" && typeof candidate.email === "string" && typeof candidate.telefone === "string"
      ? { nome: candidate.nome.trim(), email: candidate.email.trim().toLowerCase(), telefone: candidate.telefone.trim() }
      : undefined
  }
}
