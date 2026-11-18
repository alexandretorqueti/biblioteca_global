import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common"
import { DEFAULT_TENANT_CHAT_CONFIG } from "@biblioteca-global/shared"
import { readFile } from "node:fs/promises"
import { EnvService } from "../../config/env.service"
import { EmailService } from "../auth/email.service"
import type { BillingAlertSender } from "../billing/billing-reconciler"
import { ForjadorService } from "../forjador/forjador.service"
import { PROVISIONAMENTO_REPOSITORY, type ProvisionamentoContext, type ProvisionamentoRepository } from "./provisionamento.repository"

export interface ProvisionamentoWorkerOptions { intervalMs?: number; maxAttempts?: number; batchSize?: number; now?: () => Date }

@Injectable()
export class ProvisionamentoWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisionamentoWorker.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly options: Required<ProvisionamentoWorkerOptions>

  constructor(
    @Inject(PROVISIONAMENTO_REPOSITORY) private readonly repository: ProvisionamentoRepository,
    private readonly env: EnvService,
    private readonly forjador: ForjadorService,
    private readonly email: EmailService,
    @Inject("BILLING_ALERT_SENDER") private readonly alert: BillingAlertSender,
    @Optional() optionsInput: ProvisionamentoWorkerOptions = {},
  ) {
    this.options = { intervalMs: optionsInput.intervalMs ?? 60_000, maxAttempts: optionsInput.maxAttempts ?? 5, batchSize: optionsInput.batchSize ?? 25, now: optionsInput.now ?? (() => new Date()) }
  }

  onModuleInit(): void { if (!this.timer) { void this.reconcile(); this.timer = setInterval(() => { void this.reconcile() }, this.options.intervalMs); this.timer.unref() } }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const rows = await this.repository.listarParaRetry(this.options.now(), this.options.batchSize)
      for (const row of rows) await this.processOne(row.id)
    } catch (error) { this.logger.error(`falha no ciclo de provisionamento: ${error instanceof Error ? error.message : String(error)}`) }
    finally { this.running = false }
  }

  async processOne(id: number): Promise<void> {
    const row = await this.repository.claim(id)
    if (!row) return
    try {
      const context = await this.repository.contexto(row.assinaturaId)
      if (!context) throw new Error(`Pedido não encontrado para assinatura ${row.assinaturaId}`)
      if (context.pedido.status === "provisioned") { await this.repository.concluir(row.id); return }
      if (context.pedido.status === "refunded") { await this.repository.tornarDead(row.id); return }
      if (context.pedido.status === "aguardando_aceite") { await this.hold(context); return }
      if (this.env.vendasAceiteManual) {
        await this.repository.marcarPedido(context.pedido.id, "aguardando_aceite")
        await this.repository.falhar(row.id, "aguardando aceite manual", new Date(this.options.now().getTime() + 86_400_000))
        await this.alert.send(`🟡 Pedido ${context.pedido.id} aguardando aceite manual para provisionamento. Assinatura=${context.assinatura.id}.`)
        return
      }
      await this.provisionar(context)
      await this.repository.concluir(row.id)
    } catch (error) {
      await this.handleFailure(row.id, row.assinaturaId, row.tentativas, error)
    }
  }

  private async hold(context: ProvisionamentoContext): Promise<void> {
    await this.repository.falhar(context.outbox.id, "aguardando aceite manual", new Date(this.options.now().getTime() + 86_400_000))
  }

  private async provisionar(context: ProvisionamentoContext): Promise<void> {
    const { pedido, assinatura, negocio, plano } = context
    await this.repository.marcarPedido(pedido.id, "provisioning")
    await this.repository.marcarNegocio(negocio.id, "provisionando")
    const slug = this.slug(negocio.nome, negocio.id)
    const arquivos = await Promise.all(context.documentos.slice(0, 10).map(async (documento) => ({ nome: documento.nome, conteudo: (await readFile(documento.caminho)).toString("utf8").slice(0, 256 * 1024) })))
    const persona = await this.forjador.forjarPersona({ descricaoNegocio: `${negocio.nome}: ${negocio.segmentoDescricao}`, tenantSlug: slug, correlationId: `pedido-${pedido.id}`, arquivos })
    const snapshot = this.asRecord(pedido.payloadSnapshot)
    const configJson = {
      nome: negocio.nome,
      ...DEFAULT_TENANT_CHAT_CONFIG,
      persona: { ...DEFAULT_TENANT_CHAT_CONFIG.persona, tom: persona.identity.slice(0, 500) },
      ferramentas: ["catalogo"],
      plano: { slug: plano.slug, limitesCotas: this.asRecord(plano.limitesCotas) },
      transbordo: snapshot.transbordo ?? negocio.transbordo,
      documentosPendentesIndexacao: context.documentos.map((documento) => ({ id: documento.id, nome: documento.nome, usoDiferido: documento.usoDiferido })),
    }
    const tenant = await this.repository.criarOuObterTenant({ slug, nome: negocio.nome, plano: this.plano(plano.slug), configJson, personaRef: `${persona.personaId}:${persona.versao}`, contatos: this.asRecord(snapshot.contato ?? negocio.contato) })
    await this.repository.vincularAssinatura(assinatura.id, tenant.id, tenant.slug)
    if (!pedido.welcomeEmailSent) {
      const contato = this.asRecord(snapshot.contato ?? negocio.contato)
      const email = typeof contato.email === "string" ? contato.email : ""
      if (!email) throw new Error("Contato sem e-mail para boas-vindas")
      const result = await this.email.sendWelcomeEmail({ to: email, nome: negocio.nome, tenantSlug: tenant.slug, instrucoes: "Acesse o painel da Global com o e-mail desta mensagem e solicite seu código de acesso." })
      if (!result.ok) throw new Error(`E-mail de boas-vindas não enviado: ${result.reason}`)
      await this.repository.marcarEmailEnviado(pedido.id)
    }
    await this.repository.marcarPedido(pedido.id, "provisioned")
    await this.repository.marcarNegocio(negocio.id, "provisionado")
  }

  private async handleFailure(id: number, assinaturaId: number, attempts: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    if (attempts >= this.options.maxAttempts) {
      await this.repository.tornarDead(id)
      await this.repository.marcarReembolsavel(assinaturaId)
      const context = await this.repository.contexto(assinaturaId)
      if (context) { await this.repository.marcarPedido(context.pedido.id, "failed"); await this.repository.marcarNegocio(context.negocio.id, "falho") }
      await this.alert.send(`🚨 Provisionamento morto: outbox=${id}, assinatura=${assinaturaId}, tentativas=${attempts}. ${message}. Assinatura marcada como reembolsável.`)
      return
    }
    await this.repository.falhar(id, message, new Date(this.options.now().getTime() + 60_000 * 2 ** Math.max(0, attempts - 1)))
  }

  private slug(nome: string, id: number): string { const base = nome.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "tenant"; return `${base}-${id}` }
  private plano(slug: string): "starter" | "pro" | "enterprise" { return slug === "pro" || slug === "enterprise" ? slug : "starter" }
  private asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
}
