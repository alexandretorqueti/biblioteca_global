/**
 * Tipos do tenancy intra-projeto (gestao-de-tarefas-global).
 *
 * Contexto resolvido por request a partir da sessão autenticada
 * (JWT → `req.scope`, padrão apps/api/src/common/guards/global-admin.guard.ts):
 * - colaborador: vínculo `colaboradores.usuario_id = sub` com `ativo = true`;
 * - master: admin da plataforma (projeto `biblioteca-global`) sem exigir
 *   colaborador — só transita nos endpoints de master, nunca em dados de
 *   negócio (helpers `exigirContextoColaborador` abaixo).
 *
 * Sem FK física para o core: o banco do projeto (projeto_<id>) é isolado do
 * core (padrão do schema — ver comentário em `colaboradores.usuarioId`).
 */
import type { Perfil } from "@biblioteca-global/shared"

/** Slug do projeto "dono da plataforma" (espelha SLUG_ADMIN_GLOBAL de apps/api). */
export const SLUG_MASTER_PLATAFORMA = "biblioteca-global"

/**
 * Linha mínima de `colaboradores` necessária para a resolução do vínculo
 * (o repositório filtra por organização do banco do projeto; aqui só o que
 * os resolvers puros consomem).
 */
export interface LinhaColaboradorPorUsuario {
  id: number
  organizacaoId: number
  ativo: boolean
  /** Vínculo com o usuário global da plataforma (core.usuarios); NULL = desvinculado. */
  usuarioId: number | null
}

/** Contexto de negócio: usuário com colaborador ativo na organização. */
export interface ContextoColaborador {
  tipo: "colaborador"
  organizacaoId: number
  colaboradorId: number
  /** Perfil DENTRO do projeto (pivot projetos_usuarios — req.scope.projeto.perfil). */
  perfil: Perfil
}

/** Contexto master: admin da plataforma, sem vínculo de colaborador. */
export interface ContextoMaster {
  tipo: "master"
  usuarioId: number
}

export type ContextoEscopoOrganizacao = ContextoColaborador | ContextoMaster

/**
 * Shape mínimo de request consumido pelo guard — estruturalmente compatível
 * com `ApiRequest`/`ProjectScope` de apps/api (não há dependência física:
 * projeto não importa código de apps/).
 */
export interface EscopoProjetoRequest {
  usuario: { id: number }
  projeto: { id: number; nome: string; slug: string; perfil: Perfil }
}

export interface RequisicaoComEscopoOrganizacao {
  authClaims?: { sub: number; projetoId: number; perfil: string }
  scope?: EscopoProjetoRequest
  /** Preenchido pelo EscopoOrganizacaoGuard; disponível para handlers/filtros. */
  escopoOrganizacao?: ContextoEscopoOrganizacao
}

/**
 * Contrato de acesso a colaboradores para o guard (implementado contra o
 * banco do projeto — projeto_<id> — por quem registrar o guard no módulo).
 */
export interface RepositorioTenancy {
  /** Colaboradores da organização do projeto cujo usuario_id = usuarioId (ou desvinculados, para diagnóstico). */
  listarColaboradoresPorUsuario(usuarioId: number): Promise<LinhaColaboradorPorUsuario[]>
}

/** Mensagem única do bloqueio "sem colaborador ativo" (403 claro). */
export const MENSAGEM_SEM_COLABORADOR_ATIVO =
  "Usuário autenticado sem colaborador ativo nesta organização — acesso negado. " +
  "Peça ao administrador da organização para vincular seu usuário a um colaborador ativo."

/** Usuário autenticado no projeto sem colaborador ativo (→ 403 no guard). */
export class SemColaboradorAtivoError extends Error {
  constructor(message: string = MENSAGEM_SEM_COLABORADOR_ATIVO) {
    super(message)
    this.name = "SemColaboradorAtivoError"
  }
}
