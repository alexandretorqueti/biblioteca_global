// @vitest-environment node
/**
 * Unit tests dos resolvers puros de tenancy (subtarefa 1 — guard de escopo
 * organização). Cenários: usuário vinculado, desvinculado, colaborador
 * inativo, master da plataforma e bloqueio de master em dados de negócio.
 */
import { describe, expect, it } from "vitest"
import type { Perfil } from "@biblioteca-global/shared"
import {
  ehMasterPlataforma,
  exigirContextoColaborador,
  resolverColaboradorAtivo,
  resolverContextoEscopo,
} from "../resolvers"
import {
  MENSAGEM_SEM_COLABORADOR_ATIVO,
  SemColaboradorAtivoError,
  type EscopoProjetoRequest,
  type LinhaColaboradorPorUsuario,
} from "../tipos"

function scopeProjeto(
  overrides: {
    usuarioId?: number
    slug?: string
    perfil?: Perfil
  } = {},
): EscopoProjetoRequest {
  return {
    usuario: { id: overrides.usuarioId ?? 42 },
    projeto: {
      id: 13,
      nome: "Gestão de Tarefas Global",
      slug: overrides.slug ?? "gestao-de-tarefas-global",
      perfil: overrides.perfil ?? "operador",
    },
  }
}

function colaborador(
  overrides: Partial<LinhaColaboradorPorUsuario> = {},
): LinhaColaboradorPorUsuario {
  return {
    id: 7,
    organizacaoId: 3,
    ativo: true,
    usuarioId: 42,
    ...overrides,
  }
}

describe("resolverColaboradorAtivo", () => {
  it("retorna o colaborador ativo vinculado ao usuário", () => {
    const linhas = [colaborador()]
    expect(resolverColaboradorAtivo(linhas, 42)).toEqual(colaborador())
  })

  it("retorna null para usuário desvinculado (usuario_id NULL em todas as linhas)", () => {
    const linhas = [colaborador({ usuarioId: null }), colaborador({ id: 8, usuarioId: null })]
    expect(resolverColaboradorAtivo(linhas, 42)).toBeNull()
  })

  it("retorna null quando o único vínculo do usuário está inativo", () => {
    expect(resolverColaboradorAtivo([colaborador({ ativo: false })], 42)).toBeNull()
  })

  it("retorna null quando o vínculo ativo pertence a outro usuário", () => {
    expect(resolverColaboradorAtivo([colaborador({ usuarioId: 99 })], 42)).toBeNull()
  })

  it("resolve deterministicamente (menor id) com múltiplos vínculos ativos", () => {
    const linhas = [
      colaborador({ id: 11, organizacaoId: 5 }),
      colaborador({ id: 9, organizacaoId: 3 }),
    ]
    expect(resolverColaboradorAtivo(linhas, 42)?.id).toBe(9)
  })

  it("retorna null para lista vazia", () => {
    expect(resolverColaboradorAtivo([], 42)).toBeNull()
  })
})

describe("ehMasterPlataforma", () => {
  it("reconhece a sessão do projeto biblioteca-global como master", () => {
    expect(ehMasterPlataforma(scopeProjeto({ slug: "biblioteca-global" }))).toBe(true)
  })

  it("não confunde projeto de negócio com master", () => {
    expect(ehMasterPlataforma(scopeProjeto())).toBe(false)
  })
})

describe("resolverContextoEscopo", () => {
  it("retorna { organizacaoId, colaboradorId, perfil } para usuário com colaborador ativo", () => {
    const contexto = resolverContextoEscopo({
      scope: scopeProjeto({ perfil: "gerente" }),
      colaboradores: [colaborador()],
    })
    expect(contexto).toEqual({
      tipo: "colaborador",
      organizacaoId: 3,
      colaboradorId: 7,
      perfil: "gerente",
    })
  })

  it("rejeita com 403-semântica (SemColaboradorAtivoError) quando não há colaborador ativo", () => {
    expect(() =>
      resolverContextoEscopo({
        scope: scopeProjeto(),
        colaboradores: [colaborador({ ativo: false })],
      }),
    ).toThrow(SemColaboradorAtivoError)
  })

  it("mensagem de rejeição é clara e canônica", () => {
    expect(() =>
      resolverContextoEscopo({ scope: scopeProjeto(), colaboradores: [] }),
    ).toThrow(MENSAGEM_SEM_COLABORADOR_ATIVO)
  })

  it("identifica master pelo padrão global-admin sem exigir colaborador", () => {
    const contexto = resolverContextoEscopo({
      scope: scopeProjeto({ slug: "biblioteca-global", usuarioId: 1 }),
      colaboradores: [],
    })
    expect(contexto).toEqual({ tipo: "master", usuarioId: 1 })
  })
})

describe("exigirContextoColaborador", () => {
  it("passa contexto de colaborador", () => {
    const contexto = resolverContextoEscopo({
      scope: scopeProjeto(),
      colaboradores: [colaborador()],
    })
    expect(exigirContextoColaborador(contexto).colaboradorId).toBe(7)
  })

  it("rejeita master em dados de negócio com erro claro", () => {
    const master = resolverContextoEscopo({
      scope: scopeProjeto({ slug: "biblioteca-global" }),
      colaboradores: [],
    })
    expect(() => exigirContextoColaborador(master)).toThrow(
      /não opera diretamente sobre dados de negócio/,
    )
  })
})
