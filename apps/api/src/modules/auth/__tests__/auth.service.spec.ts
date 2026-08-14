import { beforeEach, describe, expect, it } from "vitest"
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import argon2 from "argon2"
import type {
  LoginIdentifierType,
  Perfil,
  ProjetoResumo,
} from "@biblioteca-global/shared"
import { EnvService } from "../../../config/env.service"
import type { RefreshTokenRow } from "../auth.repository"
import type {
  AuthRepository,
  ResolvedScope,
  UsuarioRow,
} from "../auth.repository"
import { AuthService } from "../auth.service"

/** Repositório em memória para testes unitários rápidos e determinísticos. */
class FakeAuthRepository implements AuthRepository {
  usuarios: UsuarioRow[] = []
  projetos: { id: number; nome: string; slug: string; ativo: boolean }[] = []
  vinculos: { usuarioId: number; projetoId: number; perfil: Perfil }[] = []
  refreshTokens: (RefreshTokenRow & { tokenHash: string })[] = []
  private proximoTokenId = 1

  async findUsuarioByIdentifier(
    identifierType: LoginIdentifierType,
    identifier: string,
  ): Promise<UsuarioRow | undefined> {
    const coluna =
      identifierType === "email"
        ? "email"
        : identifierType === "username"
          ? "username"
          : identifierType === "phone"
            ? "telefone"
            : "cpf"
    return this.usuarios.find((u) => u[coluna] === identifier)
  }

  async findUsuarioById(id: number): Promise<UsuarioRow | undefined> {
    return this.usuarios.find((u) => u.id === id)
  }

  async listProjetosDoUsuario(usuarioId: number): Promise<ProjetoResumo[]> {
    return this.vinculos
      .filter((v) => v.usuarioId === usuarioId)
      .map((v) => {
        const projeto = this.projetos.find((p) => p.id === v.projetoId)
        if (!projeto || !projeto.ativo) return undefined
        return {
          id: projeto.id,
          nome: projeto.nome,
          slug: projeto.slug,
          perfil: v.perfil,
        }
      })
      .filter((p): p is ProjetoResumo => p !== undefined)
  }

  async findProjetoAtivo(
    projetoId: number,
  ): Promise<{ id: number; nome: string; slug: string } | undefined> {
    const projeto = this.projetos.find(
      (p) => p.id === projetoId && p.ativo,
    )
    return projeto
      ? { id: projeto.id, nome: projeto.nome, slug: projeto.slug }
      : undefined
  }

  async findPerfilNoProjeto(
    usuarioId: number,
    projetoId: number,
  ): Promise<Perfil | undefined> {
    return this.vinculos.find(
      (v) => v.usuarioId === usuarioId && v.projetoId === projetoId,
    )?.perfil
  }

  async resolveScope(
    usuarioId: number,
    projetoId: number,
  ): Promise<ResolvedScope | undefined> {
    const usuario = this.usuarios.find((u) => u.id === usuarioId && u.ativo)
    const projeto = this.projetos.find((p) => p.id === projetoId && p.ativo)
    const vinculo = this.vinculos.find(
      (v) => v.usuarioId === usuarioId && v.projetoId === projetoId,
    )
    if (!usuario || !projeto || !vinculo) return undefined
    return {
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        username: usuario.username,
        email: usuario.email,
        telefone: usuario.telefone,
        cpf: usuario.cpf,
      },
      projeto: {
        id: projeto.id,
        nome: projeto.nome,
        slug: projeto.slug,
        perfil: vinculo.perfil,
      },
    }
  }

  async createRefreshToken(row: {
    usuarioId: number
    tokenHash: string
    expiresAt: Date
  }): Promise<void> {
    this.refreshTokens.push({
      id: this.proximoTokenId++,
      usuarioId: row.usuarioId,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      revoked: false,
    })
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRow | undefined> {
    return this.refreshTokens.find((t) => t.tokenHash === tokenHash)
  }

  async revokeRefreshToken(id: number): Promise<void> {
    const token = this.refreshTokens.find((t) => t.id === id)
    if (token) token.revoked = true
  }

  async updatePasswordHash(
    usuarioId: number,
    passwordHash: string,
  ): Promise<void> {
    const usuario = this.usuarios.find((u) => u.id === usuarioId)
    if (usuario) usuario.passwordHash = passwordHash
  }
}

function makeUsuario(overrides: Partial<UsuarioRow>): UsuarioRow {
  return {
    id: 1,
    username: "alexandre",
    email: "alexandre@globaltecnologia.com.br",
    telefone: null,
    cpf: null,
    nome: "Alexandre",
    ativo: true,
    passwordHash: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const SENHA = "senha-correta-123"

describe("AuthService", () => {
  let repo: FakeAuthRepository
  let service: AuthService
  let jwt: JwtService

  beforeEach(async () => {
    repo = new FakeAuthRepository()
    repo.usuarios.push(
      makeUsuario({ id: 1, passwordHash: await argon2.hash(SENHA) }),
    )
    repo.usuarios.push(
      makeUsuario({
        id: 2,
        username: "inativa",
        email: "inativa@exemplo.com",
        ativo: false,
        passwordHash: await argon2.hash(SENHA),
      }),
    )
    repo.projetos.push(
      { id: 1, nome: "Biblioteca Global", slug: "biblioteca-global", ativo: true },
      { id: 2, nome: "Documentação", slug: "documentacao", ativo: true },
      { id: 3, nome: "Desativado", slug: "desativado", ativo: false },
    )
    repo.vinculos.push(
      { usuarioId: 1, projetoId: 1, perfil: "admin" },
      { usuarioId: 1, projetoId: 2, perfil: "visualizador" },
    )

    jwt = new JwtService({ secret: "segredo-de-teste" })
    const env = {
      jwtAccessTtl: "15m",
      refreshTokenTtlDays: 7,
    } as unknown as EnvService
    service = new AuthService(repo, jwt, env)
  })

  describe("login", () => {
    it("aceita credencial válida e devolve refresh + projetos", async () => {
      const resposta = await service.login({
        identifier: "alexandre",
        password: SENHA,
        identifierType: "username",
      })
      expect(resposta.refreshToken).toBeTruthy()
      expect(resposta.usuario.nome).toBe("Alexandre")
      expect(resposta.usuario).not.toHaveProperty("passwordHash")
      expect(resposta.projetos).toHaveLength(2)
      expect(resposta.projetos.map((p) => p.slug).sort()).toEqual(
        ["biblioteca-global", "documentacao"],
      )
    })

    it("rejeita senha errada", async () => {
      await expect(
        service.login({
          identifier: "alexandre",
          password: "senha-errada",
          identifierType: "username",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })

    it("rejeita usuário inativo", async () => {
      await expect(
        service.login({
          identifier: "inativa",
          password: SENHA,
          identifierType: "username",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })

    it("rejeita identificador inexistente", async () => {
      await expect(
        service.login({
          identifier: "nao-existe",
          password: SENHA,
          identifierType: "email",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })
  })

  describe("selectProject", () => {
    it("emite access token com claims corretos do projeto", async () => {
      const resposta = await service.selectProject(1, { projetoId: 1 })
      const claims = await jwt.verifyAsync<{
        sub: number
        projetoId: number
        perfil: string
      }>(resposta.accessToken)
      expect(claims.sub).toBe(1)
      expect(claims.projetoId).toBe(1)
      expect(claims.perfil).toBe("admin")
      expect(resposta.projeto.slug).toBe("biblioteca-global")

      const outro = await service.selectProject(1, { projetoId: 2 })
      const claimsOutro = await jwt.verifyAsync<{ perfil: string }>(
        outro.accessToken,
      )
      expect(claimsOutro.perfil).toBe("visualizador")
    })

    it("rejeita projeto sem vínculo", async () => {
      await expect(
        service.selectProject(2, { projetoId: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it("rejeita projeto inexistente/inativo", async () => {
      await expect(
        service.selectProject(1, { projetoId: 999 }),
      ).rejects.toBeInstanceOf(NotFoundException)
      await expect(
        service.selectProject(1, { projetoId: 3 }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe("refresh e logout", () => {
    it("rotaciona o refresh token (o antigo deixa de valer)", async () => {
      const login = await service.login({
        identifier: "alexandre",
        password: SENHA,
        identifierType: "username",
      })
      const renovado = await service.refresh(login.refreshToken)
      expect(renovado.refreshToken).not.toBe(login.refreshToken)
      expect(renovado.projetos).toHaveLength(2)

      await expect(service.refresh(login.refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
    })

    it("logout revoga o refresh token", async () => {
      const login = await service.login({
        identifier: "alexandre",
        password: SENHA,
        identifierType: "username",
      })
      await service.logout(login.refreshToken)
      await expect(service.refresh(login.refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
    })
  })

  describe("changePassword", () => {
    it("rejeita senha atual incorreta", async () => {
      await expect(
        service.changePassword(1, {
          senhaAtual: "errada",
          novaSenha: "nova-senha-123",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it("troca a senha: nova funciona, antiga falha", async () => {
      await service.changePassword(1, {
        senhaAtual: SENHA,
        novaSenha: "nova-senha-123",
      })
      await expect(
        service.login({
          identifier: "alexandre",
          password: "nova-senha-123",
          identifierType: "username",
        }),
      ).resolves.toBeTruthy()
      await expect(
        service.login({
          identifier: "alexandre",
          password: SENHA,
          identifierType: "username",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })
  })
})
