/**
 * Tipos e DTOs de autenticação/sessão (PoC §5).
 *
 * Regra central: o escopo vem do TOKEN (claims { sub, projetoId, perfil }),
 * nunca do body/query/header. `projetoId` jamais é enviado pelo cliente.
 */
import { z } from "zod"

/** Identificadores aceitos pelo AuthPanel (PoC §4.2 — regra de identificador). */
export const loginIdentifierTypeSchema = z.enum([
  "email",
  "username",
  "phone",
  "cpf",
  "document",
])

export type LoginIdentifierType = z.infer<typeof loginIdentifierTypeSchema>

/** Perfil do usuário DENTRO de um projeto (pivot projetos_usuarios). */
export const perfilSchema = z.enum([
  "admin",
  "gerente",
  "operador",
  "visualizador",
])

export type Perfil = z.infer<typeof perfilSchema>

export const loginRequestSchema = z
  .object({
    identifier: z.string().min(1),
    password: z.string().min(1),
    identifierType: loginIdentifierTypeSchema,
  })
  .strict()

export type LoginRequest = z.infer<typeof loginRequestSchema>

export const selectProjectRequestSchema = z
  .object({
    projetoId: z.number().int().positive(),
  })
  .strict()

export type SelectProjectRequest = z.infer<typeof selectProjectRequestSchema>

export const changePasswordRequestSchema = z
  .object({
    senhaAtual: z.string().min(1),
    novaSenha: z.string().min(8),
  })
  .strict()

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>

// ── Auth por código (passwordless — auth única, 2026-08-15) ────────────

/** POST /auth/request-code — pedido de código por e-mail. */
export const requestCodeRequestSchema = z
  .object({
    email: z.string().email(),
  })
  .strict()

export type RequestCodeRequest = z.infer<typeof requestCodeRequestSchema>

/** POST /auth/verify-code — valida o código recebido. */
export const verifyCodeRequestSchema = z
  .object({
    email: z.string().email(),
    code: z.string().length(6),
  })
  .strict()

export type VerifyCodeRequest = z.infer<typeof verifyCodeRequestSchema>

/** POST /auth/set-password — define senha na 1ª vez (autenticado pelo token efêmero). */
export const setPasswordRequestSchema = z
  .object({
    verificationToken: z.string().min(1),
    novaSenha: z.string().min(8),
  })
  .strict()

export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>

/** Resposta sempre igual do request-code — não revela se a conta existe (D4). */
export interface RequestCodeResponse {
  ok: true
}

/**
 * Resposta do verify-code:
 * - 1ª vez (sem senha): token efêmero p/ autorizar o set-password.
 * - Com senha: login completo (mesmo formato do login por senha).
 */
export type VerifyCodeResponse =
  | { primeiraVez: true; verificationToken: string }
  | {
      primeiraVez: false
      refreshToken: string
      usuario: UsuarioAutenticado
      projetos: ProjetoResumo[]
    }

export interface SetPasswordResponse {
  ok: true
}

/** POST /provision/project — chamado pelo GerenteAgentes (token de serviço). */
export interface ProvisionProjectRequest {
  email: string
  nome?: string
  projetoNome: string
  projetoSlug?: string
}

export interface ProvisionProjectResponse {
  usuarioId: number
  projetoId: number
  perfil: "admin"
  /** true se o usuário foi criado agora (não existia). */
  criado: boolean
}

/** Projeto com o perfil do usuário logado (lista entregue no login). */
export interface ProjetoResumo {
  id: number
  nome: string
  slug: string
  perfil: Perfil
}

export interface LoginResponse {
  /** Refresh token global (sem escopo de projeto) — revogável no logout. */
  refreshToken: string
  usuario: UsuarioAutenticado
  projetos: ProjetoResumo[]
}

export interface SelectProjectResponse {
  /** Access token curto (~15 min) com claims { sub, projetoId, perfil }. */
  accessToken: string
  projeto: ProjetoResumo
}

export interface RefreshResponse {
  refreshToken: string
  projetos: ProjetoResumo[]
}

/** Claims do access token — escopo do projeto vem SEMPRE daqui. */
export interface AccessTokenClaims {
  /** id do usuário. */
  sub: number
  projetoId: number
  perfil: Perfil
}

export type AuthTokenClaims = AccessTokenClaims

/** Usuário retornado pela API — nunca inclui password_hash. */
export interface UsuarioAutenticado {
  id: number
  nome: string
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
}

/** Sessão no front: token em memória/Context (+ localStorage opcional). */
export interface SessionInfo {
  usuario: UsuarioAutenticado
  projeto: ProjetoResumo | null
  accessToken: string | null
  /** true somente no projeto biblioteca-global (admin global — PoC §8). */
  globalAdmin: boolean
}

/** Resposta do GET /auth/me. */
export interface MeResponse {
  usuario: UsuarioAutenticado
  projeto: ProjetoResumo | null
  perfil: Perfil | null
}
