import { BadRequestException, Inject, Injectable } from "@nestjs/common"
import { createHash, randomBytes } from "crypto"
import { and, eq, gt, isNull, lt, desc } from "drizzle-orm"
import { transbordoConfigSchema, type TransbordoConfig } from "@biblioteca-global/shared"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { transbordoConfig, transbordos } from "../../../../../database/schema"

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000

@Injectable()
export class TransbordoService {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async salvarConfig(tenantSlug: string, input: unknown): Promise<TransbordoConfig> {
    const parsed = transbordoConfigSchema.safeParse(input)
    if (!parsed.success) {
      throw new BadRequestException({ message: "Configuração de transbordo inválida", issues: parsed.error.issues })
    }
    const value = parsed.data
    const destino = value.destino
    const row = {
      tenantSlug,
      ativo: value.ativo,
      destinoTipo: destino.tipo,
      destinoValor: destino.valor,
      atendenteNome: destino.nomeAtendente,
      horario: value.horario,
    }
    const [existing] = await this.db.select({ id: transbordoConfig.id })
      .from(transbordoConfig)
      .where(eq(transbordoConfig.tenantSlug, tenantSlug))
      .limit(1)
    if (existing) {
      await this.db.update(transbordoConfig).set(row).where(eq(transbordoConfig.id, existing.id))
    } else {
      await this.db.insert(transbordoConfig).values(row)
    }
    return value
  }

  async obterConfig(tenantSlug: string): Promise<TransbordoConfig | null> {
    const [row] = await this.db.select().from(transbordoConfig)
      .where(eq(transbordoConfig.tenantSlug, tenantSlug)).limit(1)
    if (!row) return null
    return transbordoConfigSchema.parse({
      ativo: row.ativo,
      destino: { tipo: row.destinoTipo, valor: row.destinoValor, nomeAtendente: row.atendenteNome },
      horario: row.horario,
    })
  }

  async verificarPossivel(input: { tenantSlug: string; agora?: Date }): Promise<{
    possivel: boolean
    motivo?: "configuracao_ausente" | "inativo" | "fora_do_horario" | "destino_nao_configurado"
    config: TransbordoConfig | null
  }> {
    const config = await this.obterConfig(input.tenantSlug)
    if (!config) return { possivel: false, motivo: "configuracao_ausente", config: null }
    if (!config.ativo) return { possivel: false, motivo: "inativo", config }
    if (!config.destino.valor.trim() || !config.destino.nomeAtendente.trim()) {
      return { possivel: false, motivo: "destino_nao_configurado", config }
    }
    const agora = input.agora ?? new Date()
    let partes: Intl.DateTimeFormatPart[]
    try {
      partes = new Intl.DateTimeFormat("en-US", {
        timeZone: config.horario.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(agora)
    } catch {
      return { possivel: false, motivo: "fora_do_horario", config }
    }
    const weekday = partes.find((parte) => parte.type === "weekday")?.value
    const dia = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[weekday ?? ""]
    const hora = `${partes.find((parte) => parte.type === "hour")?.value ?? "00"}:${partes.find((parte) => parte.type === "minute")?.value ?? "00"}`
    if (dia === undefined || !config.horario.diasSemana.includes(dia) || hora < config.horario.inicio || hora >= config.horario.fim) {
      return { possivel: false, motivo: "fora_do_horario", config }
    }
    return { possivel: true, config }
  }

  /** Cria o registro pausando a sessão; o token bruto só é retornado uma vez. */
  async criarRegistro(input: { tenantSlug: string; sessaoId: number }): Promise<{ id: number; tokenLiberacao: string; expiraEm: Date; jaExistente?: boolean }> {
    const [active] = await this.db.select({ id: transbordos.id, expiraEm: transbordos.tokenLiberacaoExpiraEm })
      .from(transbordos).where(and(eq(transbordos.sessaoId, input.sessaoId), eq(transbordos.estado, "active"))).orderBy(desc(transbordos.id)).limit(1)
    if (active) return { id: active.id, tokenLiberacao: "", expiraEm: active.expiraEm, jaExistente: true }
    const tokenLiberacao = randomBytes(32).toString("hex")
    const expiraEm = new Date(Date.now() + TOKEN_TTL_MS)
    const result = await this.db.insert(transbordos).values({
      tenantSlug: input.tenantSlug,
      sessaoId: input.sessaoId,
      estado: "active",
      tokenLiberacaoHash: createHash("sha256").update(tokenLiberacao).digest("hex"),
      tokenLiberacaoExpiraEm: expiraEm,
    })
    return { id: Number(result[0].insertId), tokenLiberacao, expiraEm }
  }

  async registrarNotificacao(input: { id: number; sucesso: boolean; erro?: string }): Promise<void> {
    await this.db.update(transbordos).set({
      notificacaoEstado: input.sucesso ? "sent" : "failed",
      notificacaoTentadaEm: new Date(),
      notificacaoEnviadaEm: input.sucesso ? new Date() : null,
      notificacaoErro: input.sucesso ? null : (input.erro ?? "Falha desconhecida"),
    }).where(eq(transbordos.id, input.id))
  }

  /** Uso único e expiração são garantidos pela condição atômica do UPDATE. */
  async liberarPorToken(tokenLiberacao: string): Promise<boolean> {
    const result = await this.liberarPorTokenDetalhes(tokenLiberacao)
    return result.ok
  }

  async liberarPorTokenDetalhes(tokenLiberacao: string): Promise<{ ok: boolean; sessaoId?: number }> {
    const hash = createHash("sha256").update(tokenLiberacao).digest("hex")
    const agora = new Date()
    const [row] = await this.db.select({ id: transbordos.id, sessaoId: transbordos.sessaoId })
      .from(transbordos).where(and(eq(transbordos.tokenLiberacaoHash, hash), isNull(transbordos.tokenLiberacaoUsadoEm), gt(transbordos.tokenLiberacaoExpiraEm, agora), eq(transbordos.estado, "active"))).limit(1)
    const result = await this.db.update(transbordos).set({
      estado: "released",
      tokenLiberacaoUsadoEm: agora,
      liberadoEm: agora,
      liberadoPor: "magic-link",
    }).where(and(
      eq(transbordos.tokenLiberacaoHash, hash),
      isNull(transbordos.tokenLiberacaoUsadoEm),
      gt(transbordos.tokenLiberacaoExpiraEm, agora),
      eq(transbordos.estado, "active"),
    ))
    return { ok: Number(result[0].affectedRows ?? 0) === 1, sessaoId: row?.sessaoId }
  }

  async liberarPorOperador(input: { tenantSlug: string; sessaoId: number; ator: string }): Promise<{ ok: boolean }> {
    const agora = new Date()
    const result = await this.db.update(transbordos).set({ estado: "released", liberadoEm: agora, liberadoPor: input.ator })
      .where(and(eq(transbordos.tenantSlug, input.tenantSlug), eq(transbordos.sessaoId, input.sessaoId), eq(transbordos.estado, "active")))
    return { ok: Number(result[0].affectedRows ?? 0) === 1 }
  }

  async expirarPendentes(): Promise<void> {
    await this.db.update(transbordos).set({ estado: "expired" }).where(and(
      eq(transbordos.estado, "active"),
      lt(transbordos.tokenLiberacaoExpiraEm, new Date()),
    ))
  }
}
