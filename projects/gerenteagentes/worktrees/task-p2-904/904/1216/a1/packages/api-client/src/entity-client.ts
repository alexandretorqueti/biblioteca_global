/**
 * Cliente REST tipado por resource (PoC §6.2 — CRUD genérico).
 * O resource é resolvido no back pela whitelist do schema do projeto do
 * token. A URL segue o padrão /api/:slug/:resource.
 *
 * Resources reservados (usuarios, projetos) têm controllers dedicados
 * sem o slug na URL — o roteamento é automático.
 */
import type {
  EntityRecord,
  FieldValues,
  ListParams,
  PaginatedResult,
} from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

/**
 * Resources com endpoint dedicado no backend (sem slug na URL).
 * O CrudService bloqueia esses nomes no CRUD genérico; os controllers
 * específicos (UsuariosController, ProjetosController) respondem em
 * /api/usuarios e /api/projetos diretamente.
 */
const RESOURCES_COM_ENDPOINT_DEDICADO: ReadonlySet<string> = new Set([
  "usuarios",
  "projetos",
])

/**
 * Resolve o prefixo da URL para um resource: vazio para resources com
 * endpoint dedicado (usuarios, projetos) ou /:slug para os demais.
 * Exportada para uso em outros pontos que montam URLs diretamente
 * (ex.: getLoadOptions no ProjectContext).
 */
export function resolverPrefixoResource(slug: string, resource: string): string {
  return RESOURCES_COM_ENDPOINT_DEDICADO.has(resource) ? "" : `/${slug}`
}

export class RestEntityClient<T extends EntityRecord> {
  /** Prefixo da URL: vazio para resources dedicados, /:slug para os demais. */
  private readonly prefixo: string

  constructor(
    private readonly http: ApiHttpClient,
    private readonly slug: string,
    private readonly resource: string,
  ) {
    this.prefixo = RESOURCES_COM_ENDPOINT_DEDICADO.has(resource)
      ? ""
      : `/${this.slug}`
  }

  list(params: ListParams = {}): Promise<PaginatedResult<T>> {
    const query: Record<string, string | number | boolean | undefined> = {
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      ...params.filters,
    }
    // Serializar orderBy: "campo:asc,campo:desc,campo:asc:v1|v2"
    if (params.orderBy && params.orderBy.length > 0) {
      const orderByStr = params.orderBy
        .map((item) => {
          let str = `${item.campo}:${item.direction}`
          if (item.valuesLast && item.valuesLast.length > 0) {
            str += `:${item.valuesLast.join("|")}`
          }
          return str
        })
        .join(",")
      query.orderBy = orderByStr
    }
    return this.http.request<PaginatedResult<T>>(
      "GET",
      `${this.prefixo}/${this.resource}`,
      { query, auth: "access" },
    )
  }

  get(id: string | number): Promise<T> {
    return this.http.request<T>("GET", `${this.prefixo}/${this.resource}/${id}`, {
      auth: "access",
    })
  }

  create(values: FieldValues): Promise<T> {
    return this.http.request<T>("POST", `${this.prefixo}/${this.resource}`, {
      body: values,
      auth: "access",
    })
  }

  update(id: string | number, values: FieldValues): Promise<T> {
    return this.http.request<T>("PUT", `${this.prefixo}/${this.resource}/${id}`, {
      body: values,
      auth: "access",
    })
  }

  remove(id: string | number): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>(
      "DELETE",
      `${this.prefixo}/${this.resource}/${id}`,
      { auth: "access" },
    )
  }
}
