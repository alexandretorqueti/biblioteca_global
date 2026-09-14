import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import type {
  DadosExportResponse,
  ExclusaoResponse,
  RetificacaoRequest,
  UsuarioDadosExport,
} from "@biblioteca-global/shared"
import { SLUG_ADMIN_GLOBAL } from "../../common/guards/global-admin.guard"
import type { ProjectScope } from "../../common/types"
import {
  LGPD_REPOSITORY,
  type LgpdRepository,
} from "./lgpd.repository"

@Injectable()
export class LgpdService {
  constructor(
    @Inject(LGPD_REPOSITORY) private readonly repo: LgpdRepository,
  ) {}

  async exportar(
    scope: ProjectScope,
    usuarioId: number,
    ip: string | null,
  ): Promise<DadosExportResponse> {
    this.autorizar(scope, usuarioId)
    const dados = await this.repo.exportarDados(usuarioId)
    if (!dados) throw new NotFoundException("Usuário não encontrado")
    await this.repo.registrarAcesso({
      usuarioId,
      tipoDado: "dados_pessoais",
      acao: "exportacao",
      ip,
    })
    return { dados }
  }

  async retificar(
    scope: ProjectScope,
    usuarioId: number,
    dados: RetificacaoRequest,
    ip: string | null,
  ): Promise<UsuarioDadosExport> {
    this.autorizar(scope, usuarioId)
    const atual = await this.repo.exportarDados(usuarioId)
    if (!atual) throw new NotFoundException("Usuário não encontrado")
    await this.repo.retificarDados(usuarioId, dados)
    await this.repo.registrarAcesso({
      usuarioId,
      tipoDado: "dados_pessoais",
      acao: "retificacao",
      ip,
    })
    const atualizado = await this.repo.exportarDados(usuarioId)
    if (!atualizado) throw new NotFoundException("Usuário não encontrado")
    return atualizado
  }

  async excluir(
    scope: ProjectScope,
    usuarioId: number,
    ip: string | null,
  ): Promise<ExclusaoResponse> {
    this.autorizar(scope, usuarioId)
    const atual = await this.repo.exportarDados(usuarioId)
    if (!atual) throw new NotFoundException("Usuário não encontrado")
    await this.repo.anonimizarDados(usuarioId)
    await this.repo.registrarAcesso({
      usuarioId,
      tipoDado: "dados_pessoais",
      acao: "exclusao",
      ip,
    })
    return {
      ok: true,
      usuario_id: usuarioId,
      excluido_em: new Date().toISOString(),
    }
  }

  private autorizar(scope: ProjectScope, usuarioId: number): void {
    if (scope.usuario.id === usuarioId) return
    if (
      scope.projeto.slug === SLUG_ADMIN_GLOBAL &&
      scope.projeto.perfil === "admin"
    ) {
      return
    }
    throw new ForbiddenException(
      "Somente o próprio usuário ou o admin global pode operar estes dados",
    )
  }
}
