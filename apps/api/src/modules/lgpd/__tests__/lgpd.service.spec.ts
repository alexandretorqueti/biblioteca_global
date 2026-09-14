// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ForbiddenException } from "@nestjs/common"
import type {
  RetificacaoRequest,
  UsuarioDadosExport,
} from "@biblioteca-global/shared"
import type { ProjectScope } from "../../../common/types"
import { LgpdService } from "../lgpd.service"
import type {
  LgpdRepository,
  LogAcessoDadosSensiveis,
} from "../lgpd.repository"

const dados: UsuarioDadosExport = {
  id: 7,
  username: "usuario",
  email: "usuario@example.com",
  telefone: null,
  cpf: null,
  nome: "Usuário",
  ativo: true,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  consentimentos: [],
  vinculos: [],
}

class FakeRepository implements LgpdRepository {
  logs: LogAcessoDadosSensiveis[] = []
  atual = dados

  async exportarDados(usuarioId: number): Promise<UsuarioDadosExport | undefined> {
    return usuarioId === this.atual.id ? this.atual : undefined
  }

  async retificarDados(usuarioId: number, dados: RetificacaoRequest): Promise<void> {
    void usuarioId
    void dados
  }

  async anonimizarDados(usuarioId: number): Promise<void> {
    this.atual = { ...this.atual, id: usuarioId, nome: "Usuário Excluído", ativo: false }
  }

  async registrarAcesso(log: LogAcessoDadosSensiveis): Promise<void> {
    this.logs.push(log)
  }

  async listarAcessos(): Promise<never[]> {
    return []
  }
}

function scope(usuarioId: number, slug = "meu-projeto", perfil: "admin" | "operador" = "operador"): ProjectScope {
  return {
    usuario: { id: usuarioId, nome: "Usuário", username: "usuario", email: "usuario@example.com", telefone: null, cpf: null },
    projeto: { id: 1, nome: slug, slug, perfil },
  }
}

describe("LgpdService", () => {
  it("impede usuário comum de exportar dados de outra pessoa", async () => {
    const service = new LgpdService(new FakeRepository())
    await expect(service.exportar(scope(9), 7, null)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("permite o titular e registra a operação", async () => {
    const repo = new FakeRepository()
    const service = new LgpdService(repo)
    const response = await service.exportar(scope(7), 7, "127.0.0.1")
    expect(response.dados.id).toBe(7)
    expect(repo.logs).toEqual([{ usuarioId: 7, tipoDado: "dados_pessoais", acao: "exportacao", ip: "127.0.0.1" }])
  })

  it("permite admin global operar em outro usuário", async () => {
    const repo = new FakeRepository()
    const service = new LgpdService(repo)
    await service.excluir(scope(1, "biblioteca-global", "admin"), 7, null)
    expect(repo.logs[0]?.acao).toBe("exclusao")
  })
})
