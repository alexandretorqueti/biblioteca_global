import { BadRequestException, Inject, Injectable } from "@nestjs/common"
import { createHash, randomBytes } from "crypto"
import { and, eq, gt, isNull, lt } from "drizzle-orm"
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

  /** Cria o registro pausando a sessão; o token bruto só é retornado uma vez. */
  async criarRegistro(input: { tenantSlug: string; sessaoId: number }): Promise<{ id: number; tokenLiberacao: string; expiraEm: Date }> {
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
    const hash = createHash("sha256").update(tokenLiberacao).digest("hex")
    const agora = new Date()
    const result = await this.db.update(transbordos).set({
      estado: "released",
      tokenLiberacaoUsadoEm: agora,
      liberadoEm: agora,
    }).where(and(
      eq(transbordos.tokenLiberacaoHash, hash),
      isNull(transbordos.tokenLiberacaoUsadoEm),
      gt(transbordos.tokenLiberacaoExpiraEm, agora),
      eq(transbordos.estado, "active"),
    ))
    return Number(result[0].affectedRows ?? 0) === 1
  }

  async expirarPendentes(): Promise<void> {
    await this.db.update(transbordos).set({ estado: "expired" }).where(and(
      eq(transbordos.estado, "active"),
      lt(transbordos.tokenLiberacaoExpiraEm, new Date()),
    ))
  }
}
