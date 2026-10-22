import type { Perfil, PaginatedResult, Projeto } from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export interface GlobalUser {
  id: number
  nome: string
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
  ativo: boolean
  createdAt: string
  updatedAt: string
}
export interface GlobalUserLink { projetoId: number; projetoNome: string; projetoSlug: string; perfil: Perfil }
export interface GlobalUserDetail extends GlobalUser { vinculos: GlobalUserLink[] }
export interface CreateGlobalUserInput { nome: string; senhaInicial: string; username?: string; email?: string; telefone?: string; cpf?: string; ativo?: boolean }
export interface UpdateGlobalUserInput { nome?: string; senhaInicial?: string; username?: string; email?: string; telefone?: string; cpf?: string; ativo?: boolean }
export interface GlobalUserLinkChanges { adicionar?: Array<{ projetoId: number; perfil: Perfil }>; remover?: number[] }

export class GlobalUsersClient {
  constructor(private readonly http: ApiHttpClient) {}
  list(search?: string): Promise<PaginatedResult<GlobalUser>> { return this.http.request("GET", "/usuarios/gerais", { query: { page: 1, pageSize: 100, search }, auth: "access" }) }
  get(id: number): Promise<GlobalUserDetail> { return this.http.request("GET", `/usuarios/gerais/${id}`, { auth: "access" }) }
  create(input: CreateGlobalUserInput): Promise<GlobalUser> { return this.http.request("POST", "/usuarios/gerais", { body: input, auth: "access" }) }
  update(id: number, input: UpdateGlobalUserInput): Promise<GlobalUser> { return this.http.request("PUT", `/usuarios/gerais/${id}`, { body: input, auth: "access" }) }
  deactivate(id: number): Promise<{ ok: boolean }> { return this.http.request("DELETE", `/usuarios/gerais/${id}`, { auth: "access" }) }
  updateLinks(id: number, changes: GlobalUserLinkChanges): Promise<{ usuarioId: number }> { return this.http.request("PUT", `/usuarios/${id}/vinculos`, { body: changes, auth: "access" }) }
}

export class ProjectsClient {
  constructor(private readonly http: ApiHttpClient) {}
  list(): Promise<PaginatedResult<Projeto>> { return this.http.request("GET", "/projetos", { query: { page: 1, pageSize: 100 }, auth: "access" }) }
}
