/**
 * Cliente REST tipado por resource (PoC §6.2 — CRUD genérico).
 * O resource é resolvido no back pela whitelist do schema do projeto do
 * token — o cliente nunca informa projeto/scope.
 */
import type {
  EntityRecord,
  FieldValues,
  ListParams,
  PaginatedResult,
} from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export class RestEntityClient<T extends EntityRecord> {
  constructor(
    private readonly http: ApiHttpClient,
    private readonly resource: string,
  ) {}

  list(params: ListParams = {}): Promise<PaginatedResult<T>> {
    const query: Record<string, string | number | boolean | undefined> = {
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      ...params.filters,
    }
    return this.http.request<PaginatedResult<T>>(
      "GET",
      `/${this.resource}`,
      { query, auth: "access" },
    )
  }

  get(id: string | number): Promise<T> {
    return this.http.request<T>("GET", `/${this.resource}/${id}`, {
      auth: "access",
    })
  }

  create(values: FieldValues): Promise<T> {
    return this.http.request<T>("POST", `/${this.resource}`, {
      body: values,
      auth: "access",
    })
  }

  update(id: string | number, values: FieldValues): Promise<T> {
    return this.http.request<T>("PUT", `/${this.resource}/${id}`, {
      body: values,
      auth: "access",
    })
  }

  remove(id: string | number): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      "DELETE",
      `/${this.resource}/${id}`,
      { auth: "access" },
    )
  }
}
