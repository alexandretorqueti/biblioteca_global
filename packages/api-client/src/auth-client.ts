/**
 * Cliente de autenticação (PoC §6.2 — rotas /auth).
 */
import type {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  MeResponse,
  RefreshResponse,
  SelectProjectRequest,
  SelectProjectResponse,
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

  me(): Promise<MeResponse> {
    return this.http.request<MeResponse>("GET", "/auth/me", { auth: "access" })
  }
}
