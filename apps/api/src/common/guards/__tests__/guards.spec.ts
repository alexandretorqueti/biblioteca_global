import { beforeEach, describe, expect, it } from "vitest"
import {
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common"
import type { ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { JwtService } from "@nestjs/jwt"
import type { Perfil } from "@biblioteca-global/shared"
import { extractBearer } from "../../bearer"
import { Roles } from "../../decorators/roles.decorator"
import { JwtAuthGuard } from "../jwt-auth.guard"
import { ProjectScopeGuard } from "../project-scope.guard"
import { RolesGuard } from "../roles.guard"
import type {
  AuthRepository,
  ResolvedScope,
} from "../../../modules/auth/auth.repository"
import type { ApiRequest } from "../../types"

function makeContext(
  req: ApiRequest,
  handler: (...args: unknown[]) => unknown = () => undefined,
  classe: unknown = class {},
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => classe,
  } as unknown as ExecutionContext
}

function makeRequest(authorization?: string): ApiRequest {
  return { headers: authorization ? { authorization } : {} }
}

/** Fake mínimo do repositório para os guards. */
function makeRepo(scope: ResolvedScope | undefined): AuthRepository {
  return {
    findUsuarioByIdentifier: async () => undefined,
    findUsuarioById: async () => undefined,
    listProjetosDoUsuario: async () => [],
    findProjetoAtivo: async () => undefined,
    findPerfilNoProjeto: async () => undefined,
    resolveScope: async () => scope,
    createRefreshToken: async () => undefined,
    findRefreshTokenByHash: async () => undefined,
    revokeRefreshToken: async () => undefined,
    updatePasswordHash: async () => undefined,
    createEmailVerification: async () => undefined,
    getActiveEmailVerification: async () => undefined,
    incrementVerificationAttempts: async () => undefined,
    markVerificationUsed: async () => undefined,
  }
}

const SCOPE_VALIDO: ResolvedScope = {
  usuario: {
    id: 1,
    nome: "Alexandre",
    username: "alexandre",
    email: null,
    telefone: null,
    cpf: null,
  },
  projeto: { id: 1, nome: "Biblioteca Global", slug: "biblioteca-global", perfil: "admin" },
}

describe("JwtAuthGuard", () => {
  const jwt = new JwtService({ secret: "segredo-de-teste" })
  let guard: JwtAuthGuard

  beforeEach(() => {
    guard = new JwtAuthGuard(jwt, new Reflector())
  })

  it("rejeita request sem token", async () => {
    const req = makeRequest()
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it("rejeita token inválido", async () => {
    const req = makeRequest("Bearer nao-e-um-jwt")
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it("aceita token válido e injeta os claims", async () => {
    const token = jwt.sign({ sub: 1, projetoId: 2, perfil: "gerente" })
    const req = makeRequest(`Bearer ${token}`)
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true)
    expect(req.authClaims).toEqual({ sub: 1, projetoId: 2, perfil: "gerente" })
  })

  it("rejeita token sem claim de projeto", async () => {
    const token = jwt.sign({ sub: 1 })
    const req = makeRequest(`Bearer ${token}`)
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })
})

describe("ProjectScopeGuard", () => {
  it("rejeita request sem claims (guard fora de ordem)", async () => {
    const guard = new ProjectScopeGuard(makeRepo(SCOPE_VALIDO))
    const req = makeRequest()
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("vínculo removido → 403 (revalidação da pivot)", async () => {
    const guard = new ProjectScopeGuard(makeRepo(undefined))
    const req = makeRequest()
    req.authClaims = { sub: 1, projetoId: 1, perfil: "admin" }
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("vínculo presente → injeta o escopo", async () => {
    const guard = new ProjectScopeGuard(makeRepo(SCOPE_VALIDO))
    const req = makeRequest()
    req.authClaims = { sub: 1, projetoId: 1, perfil: "admin" }
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true)
    expect(req.scope?.projeto.slug).toBe("biblioteca-global")
    expect(req.scope?.usuario.nome).toBe("Alexandre")
  })
})

describe("RolesGuard", () => {
  class ControllerFake {
    @Roles("admin")
    soAdmin(): void {}

    @Roles("admin", "gerente")
    adminOuGerente(): void {}

    semRoles(): void {}
  }

  const guard = new RolesGuard(new Reflector())

  function contextComPerfil(perfil: Perfil | undefined, metodo: string) {
    const req = makeRequest()
    if (perfil) {
      req.scope = {
        usuario: SCOPE_VALIDO.usuario,
        projeto: { ...SCOPE_VALIDO.projeto, perfil },
      }
    }
    const handler =
      ControllerFake.prototype[metodo as keyof ControllerFake]
    return makeContext(req, handler as () => unknown, ControllerFake)
  }

  it("rota sem @Roles libera qualquer perfil", () => {
    expect(guard.canActivate(contextComPerfil("visualizador", "semRoles"))).toBe(true)
  })

  it("perfil suficiente → libera", () => {
    expect(guard.canActivate(contextComPerfil("admin", "soAdmin"))).toBe(true)
    expect(
      guard.canActivate(contextComPerfil("gerente", "adminOuGerente")),
    ).toBe(true)
  })

  it("perfil insuficiente → 403", () => {
    expect(() =>
      guard.canActivate(contextComPerfil("operador", "soAdmin")),
    ).toThrow(ForbiddenException)
  })
})

describe("extractBearer", () => {
  it("extrai o token do esquema Bearer (case-insensitive)", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123")
    expect(extractBearer("bearer abc123")).toBe("abc123")
  })

  it("devolve undefined para ausente/inválido", () => {
    expect(extractBearer(undefined)).toBeUndefined()
    expect(extractBearer("Basic abc")).toBeUndefined()
    expect(extractBearer("Bearer")).toBeUndefined()
  })
})
