// @vitest-environment node
/**
 * Unit tests do EscopoOrganizacaoGuard — injeção do contexto na request,
 * 403 claro sem colaborador ativo, master sem consulta ao banco do projeto.
 */
import { describe, expect, it, vi } from "vitest"
import {
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common"
import type { ExecutionContext } from "@nestjs/common"
import type { Perfil } from "@biblioteca-global/shared"
import {
  EscopoOrganizacaoGuard,
  contextoColaboradorDaRequest,
} from "../escopo-organizacao.guard"
import type {
  RequisicaoComEscopoOrganizacao,
  LinhaColaboradorPorUsuario,
} from "../tipos"
import { MENSAGEM_SEM_COLABORADOR_ATIVO } from "../tipos"

type RecursoRequisicaoTeste = RequisicaoComEscopoOrganizacao

function makeContext(req: RecursoRequisicaoTeste): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext
}

function makeScope(usuarioId: number, slug = "gestao-de-tarefas-global", perfil: Perfil = "operador") {
  return {
    usuario: { id: usuarioId },
    projeto: { id: 13, nome: "Gestão de Tarefas Global", slug, perfil },
  }
}

const ColaboradorAtivo: LinhaColaboradorPorUsuario = {
  id: 7,
  organizacaoId: 3,
  ativo: true,
  usuarioId: 42,
}

describe("EscopoOrganizacaoGuard", () => {
  it("injeta req.escopoOrganizacao para usuário com colaborador ativo", async () => {
    const repositorio = {
      listarColaboradoresPorUsuario: vi.fn(async () => [ColaboradorAtivo]),
    }
    const guard = new EscopoOrganizacaoGuard(repositorio)
    const req: RecursoRequisicaoTeste = { scope: makeScope(42, "gestao-de-tarefas-global", "operador") }

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true)
    expect(req.escopoOrganizacao).toEqual({
      tipo: "colaborador",
      organizacaoId: 3,
      colaboradorId: 7,
      perfil: "operador",
    })
    expect(repositorio.listarColaboradoresPorUsuario).toHaveBeenCalledWith(42)
  })

  it("rejeita com 403 e mensagem clara quando não há colaborador ativo", async () => {
    const repositorio = { listarColaboradoresPorUsuario: vi.fn(async () => []) }
    const guard = new EscopoOrganizacaoGuard(repositorio)
    const req: RecursoRequisicaoTeste = { scope: makeScope(42) }

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ForbiddenException)
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(MENSAGEM_SEM_COLABORADOR_ATIVO)
    expect(req.escopoOrganizacao).toBeUndefined()
  })

  it("rejeita 403 também quando o único vínculo está inativo", async () => {
    const repositorio = {
      listarColaboradoresPorUsuario: vi.fn(async () => [
        { ...ColaboradorAtivo, ativo: false },
      ]),
    }
    const guard = new EscopoOrganizacaoGuard(repositorio)
    const req: RecursoRequisicaoTeste = { scope: makeScope(42) }

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("reconhece master sem exigir colaborador e sem consultar o banco do projeto", async () => {
    const repositorio = {
      listarColaboradoresPorUsuario: vi.fn(async () => []),
    }
    const guard = new EscopoOrganizacaoGuard(repositorio)
    const req: RecursoRequisicaoTeste = { scope: makeScope(1, "biblioteca-global", "admin") }

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true)
    expect(req.escopoOrganizacao).toEqual({ tipo: "master", usuarioId: 1 })
    expect(repositorio.listarColaboradoresPorUsuario).not.toHaveBeenCalled()
  })

  it("401 quando a sessão de projeto não está na request (chain incompleta)", async () => {
    const guard = new EscopoOrganizacaoGuard({
      listarColaboradoresPorUsuario: vi.fn(async () => []),
    })
    const req: RecursoRequisicaoTeste = {}
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException)
  })
})

describe("contextoColaboradorDaRequest", () => {
  it("retorna o contexto de colaborador injetado", () => {
    const req: RecursoRequisicaoTeste = {
      escopoOrganizacao: { tipo: "colaborador", organizacaoId: 3, colaboradorId: 7, perfil: "operador" },
    }
    expect(contextoColaboradorDaRequest(req).colaboradorId).toBe(7)
  })

  it("rejeita master em recurso de negócio", () => {
    const req: RecursoRequisicaoTeste = {
      escopoOrganizacao: { tipo: "master", usuarioId: 1 },
    }
    expect(() => contextoColaboradorDaRequest(req)).toThrow(/dados de negócio/)
  })

  it("401 sem contexto resolvido", () => {
    expect(() => contextoColaboradorDaRequest({})).toThrow(UnauthorizedException)
  })
})
