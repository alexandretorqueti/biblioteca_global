import { Inject, Injectable } from "@nestjs/common"
import {
  LGPD_REPOSITORY,
  type LgpdRepository,
} from "./lgpd.repository"

@Injectable()
export class AcessoDadosService {
  constructor(@Inject(LGPD_REPOSITORY) private readonly repo: LgpdRepository) {}

  async registrar(input: { usuarioId: number; acao: string; ip: string | null }): Promise<void> {
    await this.repo.registrarAcesso({
      usuarioId: input.usuarioId,
      tipoDado: "cpf",
      acao: input.acao,
      ip: input.ip,
    })
  }

  async listar(limit = 100) {
    const seguro = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100
    const logs = await this.repo.listarAcessos(seguro)
    return logs.map((log) => ({
      id: log.id,
      usuario_id: log.usuarioId,
      tipo_dado: log.tipoDado,
      acao: log.acao,
      timestamp: log.timestamp.toISOString(),
      ip: log.ip,
    }))
  }
}
