export type ApiRecord = Record<string, unknown>
export type ApiFilters = Record<string, string | number | boolean>

export interface RestEntityConfig {
  baseUrl: string
  resource: string
}

export interface RestEntityClient<T extends ApiRecord> {
  list: (filters?: ApiFilters) => Promise<T[]>
  get: (id: string | number) => Promise<T>
  create: (data: ApiRecord) => Promise<T>
  update: (id: string | number, data: ApiRecord) => Promise<T>
  remove: (id: string | number) => Promise<void>
}

const request = async <T>(
  url: string,
  options?: RequestInit,
): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(
      body?.message ??
        `Erro HTTP ${response.status} ao acessar ${url}.`,
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export const createRestEntityClient = <T extends ApiRecord>({
  baseUrl,
  resource,
}: RestEntityConfig): RestEntityClient<T> => ({
  list(filters = {}) {
    const query = new URLSearchParams()

    Object.entries(filters).forEach(([key, value]) => {
      query.set(key, String(value))
    })

    const queryString = query.toString()

    return request<T[]>(
      `${baseUrl}${resource}${queryString ? `?${queryString}` : ""}`,
    )
  },

  get(id) {
    return request<T>(`${baseUrl}${resource}/${id}`)
  },

  create(data) {
    return request<T>(`${baseUrl}${resource}`, {
      method: "POST",
      body: JSON.stringify(data),
    })
  },

  update(id, data) {
    return request<T>(`${baseUrl}${resource}/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  },

  remove(id) {
    return request<void>(`${baseUrl}${resource}/${id}`, {
      method: "DELETE",
    })
  },
})

export const createCrudDataSource = <T extends ApiRecord>(
  client: RestEntityClient<T>,
  getRowId: (row: T) => string | number,
) => ({
  list: () => client.list(),
  create: (values: Record<string, string | number | boolean>) =>
    client.create(values),
  update: (
    row: T,
    values: Record<string, string | number | boolean>,
  ) => client.update(getRowId(row), values),
  remove: (row: T) => client.remove(getRowId(row)),
  getRowId,
})

interface FileUploaderConfig {
  url: string
  fieldName?: string
  headers?: HeadersInit
  getUrl?: (response: unknown) => string
}

export const createFileUploader = ({
  url,
  fieldName = "file",
  headers,
  getUrl = (response) => {
    if (
      typeof response === "object" &&
      response !== null &&
      "url" in response &&
      typeof response.url === "string"
    ) {
      return response.url
    }

    throw new Error("A resposta do upload não contém uma URL válida.")
  },
}: FileUploaderConfig) =>
  async (file: File): Promise<string> => {
    const formData = new FormData()
    formData.append(fieldName, file)

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
    })

    const body = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(
        body?.message ?? "Não foi possível enviar o arquivo.",
      )
    }

    return getUrl(body)
  }
