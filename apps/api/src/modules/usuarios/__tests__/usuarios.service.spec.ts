import { beforeEach, describe, expect, it } from "vitest"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import type { ProjectScope } from "../../../common/types"
import type { UsuarioRow } from "../../auth/auth.repository"
import { UsuariosService } from "../usuarios.service"
import type {
  ListarUsuariosFiltros,
  UsuarioListItem,
  UsuariosRepository,
} from "../usuarios.repository"

class FakeUsuariosRepository implements UsuariosRepository {
  vinculos: { usuarioId: number; projetoId: number; perfil: Perfil }[] = []
  projetos: { id: number; nome: string; slug: string; ativo: boolean }[] = []
  chamadas: string[] = []

  async listarDoProjeto(
    projetoId: number,
    filtros: ListarUsuariosFiltros,
  ): Promise<{ items: UsuarioListItem[]; total: number }> {
    this.chamadas.push(`listarDoProjeto:${projetoId}`)
    const items = this.vinculos
      .filter((v) => v.projetoId === projetoId)
      .map(
        (v): UsuarioListItem => ({
          id: v.usuarioId,
          nome: `usuario-${v.usuarioId}`,
          username: null,
          email: null,
          telefone: null,
          cpf: null,
          ativo: true,
          perfil: v.perfil,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      )
    void filtros
    return { items, total: items.length }
  }

  async findById(id: number): Promise<UsuarioRow | undefined> {
    if (id <= 0 || id > 100) return undefined
    return {
      id,
      username: `usuario-${id}`,
      email: null,
      telefone: null,
      cpf: null,
      nome: `Usuário ${id}`,
      ativo: true,
      passwordHash: "$argon2id$fake",
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  async findVinculo(
    usuarioId: number,
    projetoId: number,
  ): Promise<Perfil | undefined> {
    return this.vinculos.find(
      (v) => v.usuarioId === usuarioId && v.projetoId === projetoId,
    )?.perfil
  }

  async criarUsuario(): Promise<number> {
    return 42
  }

  async criarVinculo(
    usuarioId: number,
    projetoId: number,
    perfil: Perfil,
  ): Promise<void> {
    this.chamadas.push(`criarVinculo:${usuarioId}:${projetoId}:${perfil}`)
    this.vinculos.push({ usuarioId, projetoId, perfil })
  }

  async atualizarUsuario(): Promise<void> {
    this.chamadas.push("atualizarUsuario")
  }

  async atualizarPerfilNoProjeto(): Promise<void> {
    this.chamadas.push("atualizarPerfilNoProjeto")
  }

  async removerVinculo(usuarioId: number, projetoId: number): Promise<void> {
    this.chamadas.push(`removerVinculo:${usuarioId}:${projetoId}`)
    this.vinculos = this.vinculos.filter(
      (v) => !(v.usuarioId === usuarioId && v.projetoId === projetoId),
    )
  }

  async removerTodosVinculos(usuarioId: number): Promise<void> {
    this.chamadas.push(`removerTodosVinculos:${usuarioId}`)
    this.vinculos = this.vinculos.filter((v) => v.usuarioId !== usuarioId)
  }

  async findProjetoPorId(projetoId: number) {
    return this.projetos.find((p) => p.id === projetoId)
  }
}

function escopo(slug: string, projetoId: number, perfil: Perfil): ProjectScope {
  const projeto: ProjetoResumo = {
    id: projetoId,
    nome: slug,
    slug,
    perfil,
  }
  return {
    usuario: {
      id: 1,
      nome: "Alexandre",
      username: "alexandre",
      email: null,
      telefone: null,
      cpf: null,
    },
    projeto,
  }
}

const DTO_CRIAR = {
  nome: "Novo Usuário",
  senhaInicial: "senha-inicial-123",
  email: "novo@exemplo.com",
}

describe("UsuariosService", () => {
  let repo: FakeUsuariosRepository
  let service: UsuariosService

  beforeEach(() => {
    repo = new FakeUsuariosRepository()
    repo.projetos.push(
      { id: 1, nome: "Biblioteca Global", slug: "biblioteca-global", ativo: true },
      { id: 2, nome: "Documentação", slug: "documentacao", ativo: true },
    )
    repo.vinculos.push(
      { usuarioId: 1, projetoId: 1, perfil: "admin" },
      { usuarioId: 1, projetoId: 2, perfil: "admin" },
      { usuarioId: 2, projetoId: 2, perfil: "operador" },
    )
    service = new UsuariosService(repo)
  })

  describe("listar (escopo pela pivot)", () => {
    it("lista apenas usuários do projeto da sessão", async () => {
      const resultado = await service.listar(escopo("documentacao", 2, "admin"), {})
      expect(repo.chamadas).toContain("listarDoProjeto:2")
      expect(resultado.items.map((i) => i.id).sort()).toEqual([1, 2])
    })

    it("não lista fora do projeto sem ser admin global", async () => {
      await expect(
        service.listar(escopo("documentacao", 2, "admin"), { projetoId: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it("admin global lista usuários de outro projeto", async () => {
      const resultado = await service.listar(
        escopo("biblioteca-global", 1, "admin"),
        { projetoId: 2 },
      )
      expect(repo.chamadas).toContain("listarDoProjeto:2")
      expect(resultado.items).toHaveLength(2)
    })

    it("admin global com projetoId inexistente → 404", async () => {
      await expect(
        service.listar(escopo("biblioteca-global", 1, "admin"), {
          projetoId: 999,
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe("criar", () => {
    it("vincula automaticamente ao projeto da sessão (perfil padrão operador)", async () => {
      const criado = await service.criar(escopo("documentacao", 2, "admin"), {
        ...DTO_CRIAR,
      })
      expect(repo.chamadas).toContain("criarVinculo:42:2:operador")
      expect(criado.perfil).toBe("operador")
    })

    it("rejeita criação sem identificador", async () => {
      await expect(
        service.criar(escopo("documentacao", 2, "admin"), {
          nome: "Sem identificador",
          senhaInicial: "senha-inicial-123",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  describe("editar", () => {
    it("usuário fora do projeto da sessão → 404", async () => {
      await expect(
        service.editar(escopo("documentacao", 2, "admin"), 3, {
          nome: "X",
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe("excluir", () => {
    it("projeto comum: desvincula sem apagar o usuário global", async () => {
      await service.excluir(escopo("documentacao", 2, "admin"), 2)
      expect(repo.chamadas).toContain("removerVinculo:2:2")
      expect(repo.chamadas).not.toContain("atualizarUsuario")
      expect(repo.chamadas).not.toContain("removerTodosVinculos:2")
    })

    it("usuário fora do projeto comum → 404", async () => {
      await expect(
        service.excluir(escopo("documentacao", 2, "admin"), 3),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    it("admin global: desativa + remove todos os vínculos", async () => {
      await service.excluir(escopo("biblioteca-global", 1, "admin"), 2)
      expect(repo.chamadas).toContain("removerTodosVinculos:2")
      expect(repo.chamadas).toContain("atualizarUsuario")
    })

    it("modo global sem perfil admin → 403", async () => {
      await expect(
        service.excluir(escopo("biblioteca-global", 1, "gerente"), 2),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe("vincular (admin global)", () => {
    it("adiciona e remove vínculos", async () => {
      await service.vincular(escopo("biblioteca-global", 1, "admin"), 2, {
        adicionar: [{ projetoId: 1, perfil: "visualizador" }],
        remover: [2],
      })
      expect(repo.vinculos).toContainEqual({
        usuarioId: 2,
        projetoId: 1,
        perfil: "visualizador",
      })
      expect(repo.vinculos.find((v) => v.projetoId === 2 && v.usuarioId === 2)).toBeUndefined()
    })

    it("projeto inexistente → 404", async () => {
      await expect(
        service.vincular(escopo("biblioteca-global", 1, "admin"), 2, {
          adicionar: [{ projetoId: 999, perfil: "operador" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    it("sem operações → 400", async () => {
      await expect(
        service.vincular(escopo("biblioteca-global", 1, "admin"), 2, {}),
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  it("identificador duplicado → 409", async () => {
    const repoDup = new FakeUsuariosRepository()
    repoDup.criarUsuario = async () => {
      const erro = new Error("duplicado") as Error & { code: string }
      erro.code = "ER_DUP_ENTRY"
      throw erro
    }
    const serviceDup = new UsuariosService(repoDup)
    await expect(
      serviceDup.criar(escopo("documentacao", 2, "admin"), { ...DTO_CRIAR }),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
