/**
 * Tipos internos de requisição autenticada (PoC §5.2/§6.1).
 * Sem dependência de tipos do express — o mínimo que os guards precisam.
 */
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"

/** Token para injetar o registrador de tarefas sem carregar o schema no filtro. */
export const GESTAO_GLOBAL_TASKS_REPOSITORY = Symbol("GESTAO_GLOBAL_TASKS_REPOSITORY")

/** Claims do access token JWT — o escopo vem SEMPRE daqui. */
export interface AuthClaims {
  sub: number
  projetoId: number
  perfil: string
}

/** Escopo resolvido pelo ProjectScopeGuard (pivot revalidada). */
export interface ProjectScope {
  usuario: UsuarioAutenticado
  projeto: ProjetoResumo
}

/** Sessão de refresh (token opaco validado pelo RefreshAuthGuard). */
export interface RefreshSession {
  tokenId: number
  usuarioId: number
  token: string
}

export interface ApiRequest {
  headers: Record<string, string | string[] | undefined>
  /** IP de origem (rate-limit do request-code — Express preenche). */
  ip?: string
  authClaims?: AuthClaims
  scope?: ProjectScope
  method?: string
  originalUrl?: string
  url?: string
  route?: { path?: string }
  refreshSession?: RefreshSession
}
