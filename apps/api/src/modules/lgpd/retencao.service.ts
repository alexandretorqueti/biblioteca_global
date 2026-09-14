import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import {
  RETENCAO_REPOSITORY,
  type RetencaoRepository,
} from "./retencao.repository"

export const RETENCAO_ANOS = 5
const RETENCAO_INTERVALO_MS = 24 * 60 * 60 * 1000

@Injectable()
export class RetencaoService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    @Inject(RETENCAO_REPOSITORY) private readonly repo: RetencaoRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.executar()
    }, RETENCAO_INTERVALO_MS)
    this.timer.unref?.()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async executar(agora = new Date()): Promise<{ desativados: number }> {
    const limite = new Date(agora)
    limite.setFullYear(limite.getFullYear() - RETENCAO_ANOS)
    const usuarios = await this.repo.encontrarInativosAntesDe(limite)
    for (const usuarioId of usuarios) {
      await this.repo.desativarPorRetencao(usuarioId)
    }
    return { desativados: usuarios.length }
  }
}
