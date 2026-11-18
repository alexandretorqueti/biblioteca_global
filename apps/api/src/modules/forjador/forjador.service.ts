import { BadRequestException, GatewayTimeoutException, Inject, Injectable, InternalServerErrorException, Logger } from "@nestjs/common"
import { and, desc, eq, isNull } from "drizzle-orm"
import { createHash } from "node:crypto"
import { forjarPersonaRequestSchema, type ForjarPersonaRequest, type ForjarPersonaResponse } from "@biblioteca-global/shared"
import * as schema from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { EnvService } from "../../config/env.service"
import type { ForjadorBridge, ForjadorServiceInput } from "./forjador.types"
import { ForjadorBridgeService } from "./forjador.bridge"
import { parseForjadorResponse } from "./forjador.parser"

export { parseForjadorResponse } from "./forjador.parser"

const MAX_TEXT_LENGTH = 100_000
const POLL_INTERVAL_MS = 500
const TRANSIENT_ERROR = /Console HTTP 50[234]|Gateway connection closed|Gateway request timed out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i

function materialHash(dto: ForjarPersonaRequest): string {
  return createHash("sha256").update(JSON.stringify({ descricaoNegocio: dto.descricaoNegocio, arquivos: dto.arquivos ?? [] })).digest("hex")
}

function sessionKey(agentId: string, tenant: string, correlationId: string): string {
  const digest = createHash("sha256").update(`${tenant}:${correlationId}`).digest("hex").slice(0, 48)
  return `agent:${agentId}:forjador-${digest}`
}

function promptFor(input: ForjadorServiceInput): string {
  const files = (input.arquivos ?? []).map((file) => `\n\n### Material: ${file.nome}\n${file.conteudo}`).join("")
  return [
    "Você é o Forjador de personas. Gere uma persona coerente para o negócio descrito abaixo.",
    "NÃO aplique, escreva ou altere nada em workspaces de terceiros. Apenas devolva texto.",
    "Responda exclusivamente com os três blocos delimitados exatamente como indicado:",
    "<<<SOUL.md>>>\n(conteúdo)\n<<<END SOUL.md>>>",
    "<<<IDENTITY.md>>>\n(conteúdo)\n<<<END IDENTITY.md>>>",
    "<<<AGENTS.md>>>\n(conteúdo)\n<<<END AGENTS.md>>>",
    `\nDescrição do negócio:\n${input.descricaoNegocio}${files}`,
  ].join("\n")
}

@Injectable()
export class ForjadorService {
  private readonly logger = new Logger(ForjadorService.name)
  private readonly active = new Map<string, Promise<ForjarPersonaResponse>>()

  constructor(
    @Inject(CORE_DB) private readonly db: CoreDb,
    @Inject(ForjadorBridgeService) private readonly bridge: ForjadorBridge,
    private readonly env: EnvService,
  ) {}

  async forjarPersona(raw: ForjarPersonaRequest): Promise<ForjarPersonaResponse> {
    const parsed = forjarPersonaRequestSchema.safeParse(raw)
    if (!parsed.success) throw new BadRequestException(parsed.error.issues)
    const dto = parsed.data
    const correlationId = dto.correlationId ?? createHash("sha256").update(`${dto.descricaoNegocio}:${Date.now()}`).digest("hex")
    const input = { ...dto, correlationId }
    const key = `${dto.tenantSlug ?? dto.tenantId ?? "tenant"}:${correlationId}`
    const running = this.active.get(key)
    if (running) return running
    const work = this.run(input).finally(() => this.active.delete(key))
    this.active.set(key, work)
    return work
  }

  private async run(input: ForjadorServiceInput): Promise<ForjarPersonaResponse> {
    const tenant = input.tenantSlug ?? (input.tenantId !== undefined ? String(input.tenantId) : "tenant")
    const correlation = input.correlationId
    const tenantCondition = input.tenantSlug
      ? eq(schema.personasForjadas.tenantSlug, input.tenantSlug)
      : input.tenantId !== undefined
        ? and(isNull(schema.personasForjadas.tenantSlug), eq(schema.personasForjadas.tenantId, input.tenantId))
        : and(isNull(schema.personasForjadas.tenantSlug), isNull(schema.personasForjadas.tenantId))
    const [existing] = await this.db.select().from(schema.personasForjadas).where(and(eq(schema.personasForjadas.correlationId, correlation), tenantCondition)).orderBy(desc(schema.personasForjadas.id)).limit(1)
    if (existing?.status === "completed" && existing.soulMd && existing.identityMd && existing.agentsMd) {
      return this.response(existing.id, existing.versao, input.tenantSlug, existing.soulMd, existing.identityMd, existing.agentsMd)
    }
    const version = existing?.versao ?? await this.nextVersion(input.tenantSlug)
    const hash = materialHash(input)
    const agentId = this.env.forjadorAgentId
    const key = existing?.sessionKey ?? sessionKey(agentId, tenant, correlation)
    let id = existing?.id
    if (!existing) {
      const inserted = await this.db.insert(schema.personasForjadas).values({ tenantSlug: input.tenantSlug, tenantId: input.tenantId, descricaoNegocio: input.descricaoNegocio, materialHash: hash, correlationId: correlation, versao: version, sessionKey: key, status: "pending" }).$returningId()
      id = inserted[0]?.id
    } else {
      await this.db.update(schema.personasForjadas).set({ status: "pending", sessionKey: key, updatedAt: new Date() }).where(eq(schema.personasForjadas.id, existing.id))
    }
    if (!id) throw new InternalServerErrorException("Falha ao persistir persona pendente")

    try {
      const session = await this.bridge.resolveSession({ agentId, sessionKey: key, label: `forjador:${tenant}:${correlation}` })
      if (!existing || !session.existing) await this.bridge.send({ sessionKey: session.sessionKey, agentId, text: promptFor(input) })
      const finalText = await this.waitForCompletion(session.sessionKey, agentId)
      const texts = parseForjadorResponse(finalText)
      await this.db.update(schema.personasForjadas).set({ soulMd: texts.soul, identityMd: texts.identity, agentsMd: texts.agents, status: "completed", sessionKey: session.sessionKey, updatedAt: new Date() }).where(eq(schema.personasForjadas.id, id))
      return this.response(id, version, input.tenantSlug, texts.soul, texts.identity, texts.agents)
    } catch (error) {
      const timeout = error instanceof GatewayTimeoutException
      await this.db.update(schema.personasForjadas).set({ status: timeout ? "timeout" : "failed", updatedAt: new Date() }).where(eq(schema.personasForjadas.id, id))
      throw error
    }
  }

  private async nextVersion(tenantSlug?: string): Promise<number> {
    const rows = await this.db.select({ versao: schema.personasForjadas.versao }).from(schema.personasForjadas).where(tenantSlug ? eq(schema.personasForjadas.tenantSlug, tenantSlug) : undefined).orderBy(desc(schema.personasForjadas.versao)).limit(1)
    return (rows[0]?.versao ?? 0) + 1
  }

  private async waitForCompletion(sessionKeyValue: string, agentId: string): Promise<string> {
    const deadline = Date.now() + this.env.forjadorTimeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.bridge.describe({ sessionKey: sessionKeyValue, agentId })
        const status = String(state.status ?? state.state ?? "").toLowerCase()
        const done = status === "done" || status === "idle" || (state.hasActiveRun === false && status !== "running" && status !== "processing")
        if (done) {
          const history = await this.bridge.history({ sessionKey: sessionKeyValue, maxChars: MAX_TEXT_LENGTH * 3 })
          const response = [...history].reverse().find((message) => message.role === "agent" && message.text?.trim())?.text?.trim()
          if (response) return response
        }
      } catch (error) {
        if (!TRANSIENT_ERROR.test(error instanceof Error ? error.message : String(error))) throw error
        this.logger.warn("Erro transitório no polling do Forjador; mantendo a espera")
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    throw new GatewayTimeoutException("Tempo limite do Forjador excedido; a sessão pode ser retomada por correlationId")
  }

  private response(id: number, version: number, tenantSlug: string | undefined, soul: string, identity: string, agents: string): ForjarPersonaResponse {
    return { personaId: id, versao: version, ...(tenantSlug ? { tenantSlug } : {}), soul, identity, agents, status: "completed" }
  }
}
