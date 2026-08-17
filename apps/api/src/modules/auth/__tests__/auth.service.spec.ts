// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
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
import { EmailService } from "../email.service"
import type {
  AuthRepository,
  EmailVerificationRow,
  ResolvedScope,
  UsuarioRow,
} from "../auth.repository"
import { AuthService } from "../auth.service"
import { hashCode } from "../verification"

/** Repositório em memória para testes unitários rápidos e determinísticos. */
class FakeAuthRepository implements AuthRepository {
  usuarios: UsuarioRow[] = []
  projetos: { id: number; nome: string; slug: string; ativo: boolean }[] = []
  vinculos: { usuarioId: number; projetoId: number; perfil: Perfil }[] = []
  refreshTokens: (RefreshTokenRow & { tokenHash: string })[] = []
  emailVerifications: (EmailVerificationRow & { codeHash: string })[] = []
  private proximoTokenId = 1
  private proximaVerificacaoId = 1

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

  async createEmailVerification(row: {
    email: string
    codeHash: string
    expiresAt: Date
  }): Promise<void> {
    this.emailVerifications.push({
      id: this.proximaVerificacaoId++,
      email: row.email.toLowerCase(),
      codeHash: row.codeHash,
      expiresAt: row.expiresAt,
      attempts: 0,
      usedAt: null,
      createdAt: new Date(),
    })
  }

  async getActiveEmailVerification(
    email: string,
  ): Promise<EmailVerificationRow | undefined> {
    return [...this.emailVerifications]
      .filter(
        (v) =>
          v.email === email.toLowerCase() &&
          v.usedAt === null &&
          v.expiresAt.getTime() > Date.now(),
      )
      .sort((a, b) => b.id - a.id)[0]
  }

  async incrementVerificationAttempts(id: number): Promise<void> {
    const v = this.emailVerifications.find((x) => x.id === id)
    if (v) v.attempts += 1
  }

  async markVerificationUsed(id: number): Promise<void> {
    const v = this.emailVerifications.find((x) => x.id === id)
    if (v) v.usedAt = new Date()
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
  let email: { sendVerificationEmail: ReturnType<typeof vi.fn> }

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
      { id: 4, nome: "Gerente Agentes (piloto)", slug: "gerenteagentes", ativo: true },
    )
    repo.vinculos.push(
      { usuarioId: 1, projetoId: 1, perfil: "admin" },
      { usuarioId: 1, projetoId: 2, perfil: "visualizador" },
      { usuarioId: 1, projetoId: 4, perfil: "admin" },
    )

    jwt = new JwtService({ secret: "segredo-de-teste" })
    const env = {
      jwtAccessTtl: "15m",
      refreshTokenTtlDays: 7,
      authCodeSecret: "segredo-auth-teste",
      authCodeTtlMs: 600_000,
      authMaxAttempts: 5,
      authRateLimitMax: 3,
      authRateLimitWindowMs: 900_000,
      authVerifyTokenTtl: "5m",
    } as unknown as EnvService
    email = { sendVerificationEmail: vi.fn() }
    service = new AuthService(
      repo,
      jwt,
      env,
      email as unknown as EmailService,
    )
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
      expect(resposta.projetos).toHaveLength(3)
      expect(resposta.projetos.map((p) => p.slug).sort()).toEqual(
        ["biblioteca-global", "documentacao", "gerenteagentes"],
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
      expect(renovado.projetos).toHaveLength(3)

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

  describe("auth por código (passwordless)", () => {
    const EMAIL = "cliente@exemplo.com"
    const EMAIL_SEM_SENHA = "cliente-novo@exemplo.com"
    const CODIGO = "123456"
    const SECRET = "segredo-auth-teste"

    // Usuário com senha — alvo dos fluxos "conta existente".
    beforeEach(async () => {
      repo.usuarios.push(
        makeUsuario({
          id: 20,
          email: EMAIL,
          passwordHash: await argon2.hash(SENHA),
        }),
      )
    })

    /** Cria uma verificação ativa no fake (como o request-code faria). */
    function criarVerificacao(
      email: string,
      codigo: string,
      ttlMs = 600_000,
    ): void {
      void repo.createEmailVerification({
        email,
        codeHash: hashCode(codigo, email, SECRET),
        expiresAt: new Date(Date.now() + ttlMs),
      })
    }

    describe("requestCode", () => {
      it("conta existente: gera verificação e envia o código", async () => {
        const resposta = await service.requestCode(
          { email: EMAIL },
          "127.0.0.1",
        )
        expect(resposta).toEqual({ ok: true })
        expect(email.sendVerificationEmail).toHaveBeenCalledTimes(1)
        expect(email.sendVerificationEmail).toHaveBeenCalledWith({
          to: EMAIL,
          code: expect.stringMatching(/^\d{6}$/) as unknown as string,
        })
        expect(repo.emailVerifications).toHaveLength(1)
        expect(repo.emailVerifications[0]?.email).toBe(EMAIL)
        // Nunca armazena o código em claro.
        expect(repo.emailVerifications[0]?.codeHash).not.toBe(CODIGO)
      })

      it("conta inexistente: mesma resposta { ok: true }, nada enviado", async () => {
        const resposta = await service.requestCode(
          { email: "nao-existe@exemplo.com" },
          "127.0.0.1",
        )
        expect(resposta).toEqual({ ok: true })
        expect(email.sendVerificationEmail).not.toHaveBeenCalled()
        expect(repo.emailVerifications).toHaveLength(0)
      })

      it("e-mail inválido: mesma resposta, nada enviado", async () => {
        const resposta = await service.requestCode(
          { email: "sem-arroba" },
          "127.0.0.1",
        )
        expect(resposta).toEqual({ ok: true })
        expect(email.sendVerificationEmail).not.toHaveBeenCalled()
      })

      it("rate-limit: 4º pedido na janela não gera código (resposta idêntica)", async () => {
        for (let i = 0; i < 4; i++) {
          const resposta = await service.requestCode(
            { email: EMAIL },
            "127.0.0.1",
          )
          expect(resposta).toEqual({ ok: true })
        }
        // 3 permitidos; o 4º é bloqueado silenciosamente.
        expect(email.sendVerificationEmail).toHaveBeenCalledTimes(3)
        expect(repo.emailVerifications).toHaveLength(3)
      })

      it("e-mail com case diferente conta como o mesmo (normalização)", async () => {
        await service.requestCode({ email: "Cliente@Exemplo.com" }, "ip")
        expect(email.sendVerificationEmail).toHaveBeenCalledWith({
          to: "cliente@exemplo.com",
          code: expect.stringMatching(/^\d{6}$/) as unknown as string,
        })
      })
    })

    describe("verifyCode", () => {
      it("sem senha + código certo → primeiraVez + token efêmero", async () => {
        repo.usuarios.push(
          makeUsuario({ id: 10, email: EMAIL_SEM_SENHA, passwordHash: null }),
        )
        criarVerificacao(EMAIL_SEM_SENHA, CODIGO)

        const resposta = await service.verifyCode({
          email: EMAIL_SEM_SENHA,
          code: CODIGO,
        })
        expect(resposta.primeiraVez).toBe(true)
        if (!resposta.primeiraVez) throw new Error("esperava primeiraVez")
        const claims = await jwt.verifyAsync<{ sub: number }>(
          resposta.verificationToken,
        )
        expect(claims.sub).toBe(10)
        // Código marcado como usado.
        expect(repo.emailVerifications[0]?.usedAt).not.toBeNull()
      })

      it("com senha + código certo → login completo", async () => {
        criarVerificacao(EMAIL, CODIGO)
        const resposta = await service.verifyCode({ email: EMAIL, code: CODIGO })
        expect(resposta.primeiraVez).toBe(false)
        if (resposta.primeiraVez) throw new Error("esperava login completo")
        expect(resposta.refreshToken).toBeTruthy()
        expect(resposta.usuario.email).toBe(EMAIL)
        expect(resposta.projetos).toHaveLength(0)
      })

      it("código errado → 401 e incrementa tentativas", async () => {
        criarVerificacao(EMAIL, CODIGO)
        await expect(
          service.verifyCode({ email: EMAIL, code: "999999" }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
        expect(repo.emailVerifications[0]?.attempts).toBe(1)
        expect(repo.emailVerifications[0]?.usedAt).toBeNull()
      })

      it("estouro de tentativas (5ª) invalida o código", async () => {
        criarVerificacao(EMAIL, CODIGO)
        for (let i = 0; i < 5; i++) {
          await expect(
            service.verifyCode({ email: EMAIL, code: "999999" }),
          ).rejects.toBeInstanceOf(UnauthorizedException)
        }
        expect(repo.emailVerifications[0]?.usedAt).not.toBeNull()
        // Mesmo o código certo não vale mais.
        await expect(
          service.verifyCode({ email: EMAIL, code: CODIGO }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })

      it("código expirado → 401", async () => {
        criarVerificacao(EMAIL, CODIGO, -60_000)
        await expect(
          service.verifyCode({ email: EMAIL, code: CODIGO }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })

      it("sem verificação ativa → 401", async () => {
        await expect(
          service.verifyCode({ email: EMAIL, code: CODIGO }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })
    })

    describe("setPassword", () => {
      async function tokenEfemerro(sub: number): Promise<string> {
        return jwt.signAsync({ sub }, { expiresIn: "5m" })
      }

      it("token válido grava a senha (login com a nova senha funciona)", async () => {
        repo.usuarios.push(
          makeUsuario({ id: 11, email: EMAIL, passwordHash: null }),
        )
        const token = await tokenEfemerro(11)

        const resposta = await service.setPassword({
          verificationToken: token,
          novaSenha: "nova-senha-123",
        })
        expect(resposta).toEqual({ ok: true })
        const usuario = repo.usuarios.find((u) => u.id === 11)
        expect(usuario?.passwordHash).toBeTruthy()
        expect(usuario?.passwordHash).not.toBe("nova-senha-123")
      })

      it("token inválido → 401", async () => {
        await expect(
          service.setPassword({
            verificationToken: "token-invalido",
            novaSenha: "nova-senha-123",
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })

      it("token assinado com outro segredo (expirado/inválido) → 401", async () => {
        const outroJwt = new JwtService({ secret: "outro-segredo" })
        const token = await outroJwt.signAsync({ sub: 1 }, { expiresIn: "5m" })
        await expect(
          service.setPassword({
            verificationToken: token,
            novaSenha: "nova-senha-123",
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })

      it("usuário inexistente no token → 401", async () => {
        const token = await tokenEfemerro(9999)
        await expect(
          service.setPassword({
            verificationToken: token,
            novaSenha: "nova-senha-123",
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException)
      })
    })
  })
})
