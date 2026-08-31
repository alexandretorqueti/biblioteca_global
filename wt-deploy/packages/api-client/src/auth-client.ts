/**
 * Cliente de autenticação (PoC §6.2 — rotas /auth).
 */
import type {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvisionProjectRequest,
  ProvisionProjectResponse,
  RefreshResponse,
  RequestCodeRequest,
  RequestCodeResponse,
  SelectProjectRequest,
  SelectProjectResponse,
  SetPasswordRequest,
  SetPasswordResponse,
  VerifyCodeRequest,
  VerifyCodeResponse,
} from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export class AuthClient {
  constructor(private readonly http: ApiHttpClient) {}

  login(req: LoginRequest): Promise<LoginResponse> {
    return this.http.request<LoginResponse>("POST", "/auth/login", {
      body: req,
      auth: "none",
    })
  }

  /** Usa o refresh token como credencial. */
  selectProject(req: SelectProjectRequest): Promise<SelectProjectResponse> {
    return this.http.request<SelectProjectResponse>(
      "POST",
      "/auth/select-project",
      { body: req, auth: "refresh" },
    )
  }

  /** Rotaciona o refresh token (o anterior é revogado no back). */
  refresh(): Promise<RefreshResponse> {
    return this.http.request<RefreshResponse>("POST", "/auth/refresh", {
      auth: "refresh",
    })
  }

  logout(): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>("POST", "/auth/logout", {
      auth: "refresh",
    })
  }

  changePassword(req: ChangePasswordRequest): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>("POST", "/auth/change-password", {
      body: req,
      auth: "access",
    })
  }

  /** Pedido de código por e-mail — resposta sempre { ok: true } (D4). */
  requestCode(req: RequestCodeRequest): Promise<RequestCodeResponse> {
    return this.http.request<RequestCodeResponse>("POST", "/auth/request-code", {
      body: req,
      auth: "none",
    })
  }

  /** Valida o código — 1ª vez (token efêmero) ou login completo. */
  verifyCode(req: VerifyCodeRequest): Promise<VerifyCodeResponse> {
    return this.http.request<VerifyCodeResponse>("POST", "/auth/verify-code", {
      body: req,
      auth: "none",
    })
  }

  /** Define a senha na 1ª vez (token efêmero vai no body). */
  setPassword(req: SetPasswordRequest): Promise<SetPasswordResponse> {
    return this.http.request<SetPasswordResponse>("POST", "/auth/set-password", {
      body: req,
      auth: "none",
    })
  }

  /**
   * Provisionamento (GerenteAgentes) — bearer com o TOKEN DE SERVIÇO
   * explícito, nunca o token de sessão do usuário (Etapa 8).
   */
  provisionProject(
    req: ProvisionProjectRequest,
    provisionToken: string,
  ): Promise<ProvisionProjectResponse> {
    return this.http.request<ProvisionProjectResponse>("POST", "/provision/project", {
      body: req,
      auth: "none",
      headers: { Authorization: "Bearer " + provisionToken },
    })
  }

  me(): Promise<MeResponse> {
    return this.http.request<MeResponse>("GET", "/auth/me", { auth: "access" })
  }
}
