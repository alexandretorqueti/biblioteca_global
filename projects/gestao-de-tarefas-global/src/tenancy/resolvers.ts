/**
 * Resolvers puros do tenancy intra-projeto (gestao-de-tarefas-global).
 *
 * Sem I/O e sem dependência de Nest: recebem o escopo da sessão (claims já
 * validados por jwt-auth.guard/ProjectScopeGuard) e as linhas de
 * `colaboradores` por usuário, e devolvem o contexto { organizacaoId,
 * colaboradorId, perfil } — ou rejeitam. A tradução para HTTP (403) é do
 * EscopoOrganizacaoGuard.
 *
 * Regras (REQ-F-015/016/017, REQ-D-001):
 * - sessão no projeto `biblioteca-global` = master da plataforma (padrão
 *   global-admin): reconhecido SEM exigir colaborador; só transita nos
 *   endpoints de master, nunca em dados de negócio;
 * - usuário autenticado no projeto sem colaborador ativo (vínculo
 *   `colaboradores.usuario_id = sub`, `ativo = true`) → SemColaboradorAtivoError;
 * - múltiplos vínculos ativos (não esperado; sem unique no schema):
 *   resolve deterministicamente para o de menor id.
 */
import type { Perfil } from "@biblioteca-global/shared"
import {
  MENSAGEM_SEM_COLABORADOR_ATIVO,
  SLUG_MASTER_PLATAFORMA,
  SemColaboradorAtivoError,
  type ContextoEscopoOrganizacao,
  type EscopoProjetoRequest,
  type LinhaColaboradorPorUsuario,
} from "./tipos"

/** Sessão do projeto "dono da plataforma" → master (padrão global-admin). */
export function ehMasterPlataforma(
  scope: Pick<EscopoProjetoRequest, "projeto">,
): boolean {
  return scope.projeto.slug === SLUG_MASTER_PLATAFORMA
}

/**
 * Colaborador ativo vinculado ao usuário (usuario_id = sub, ativo = true).
 * Retorna `null` quando não há vínculo ativo (desvinculado ou inativo).
 * Determinístico: com mais de um ativo, o de menor id.
 */
export function resolverColaboradorAtivo(
  colaboradores: readonly LinhaColaboradorPorUsuario[],
  usuarioId: number,
): LinhaColaboradorPorUsuario | null {
  const ativos = colaboradores
    .filter((c) => c.ativo && c.usuarioId === usuarioId)
    .sort((a, b) => a.id - b.id)
  return ativos[0] ?? null
}

/**
 * Resolve o contexto da request. Lança `SemColaboradorAtivoError` quando o
 * usuário autenticado no projeto não possui colaborador ativo (o guard
 * converte em 403 com a mensagem de `MENSAGEM_SEM_COLABORADOR_ATIVO`).
 */
export function resolverContextoEscopo(input: {
  scope: EscopoProjetoRequest
  colaboradores: readonly LinhaColaboradorPorUsuario[]
}): ContextoEscopoOrganizacao {
  const { scope, colaboradores } = input

  if (ehMasterPlataforma(scope)) {
    return { tipo: "master", usuarioId: scope.usuario.id }
  }

  const colaborador = resolverColaboradorAtivo(colaboradores, scope.usuario.id)
  if (!colaborador) {
    throw new SemColaboradorAtivoError(MENSAGEM_SEM_COLABORADOR_ATIVO)
  }
  return {
    tipo: "colaborador",
    organizacaoId: colaborador.organizacaoId,
    colaboradorId: colaborador.id,
    perfil: scope.projeto.perfil,
  }
}

/**
 * Projeta o contexto para dados de negócio: apenas colaboradores podem
 * transitar (master fica restrito aos endpoints de master — subtarefa 3).
 * Rejeita master com 403-semântica (erro claro) se chamado em recurso de negócio.
 */
export function exigirContextoColaborador(
  contexto: ContextoEscopoOrganizacao,
): Extract<ContextoEscopoOrganizacao, { tipo: "colaborador" }> {
  if (contexto.tipo !== "colaborador") {
    throw new SemColaboradorAtivoError(
      "Master da plataforma não opera diretamente sobre dados de negócio da organização — use os endpoints de administração.",
    )
  }
  return contexto
}

/** Reexporta o tipo de perfil para conveniência dos consumidores do módulo. */
export type { Perfil }
