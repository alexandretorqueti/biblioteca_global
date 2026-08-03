import entitiesConfig from "../config/entities.json"

type EntityConfig = {
  baseUrl: string
  resource: string
  primaryKey: string
}

type EntitiesConfig = Record<string, EntityConfig>

const config = entitiesConfig as EntitiesConfig

export type EntityRecord = Record<string, unknown>

const getEntityConfig = (entity: string): EntityConfig => {
  const entityConfig = config[entity]

  if (!entityConfig) {
    throw new Error(`Entidade "${entity}" não configurada.`)
  }

  return entityConfig
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

export const entityApi = {
  list<T extends EntityRecord>(
    entity: string,
    filters: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    const entityConfig = getEntityConfig(entity)
    const query = new URLSearchParams()

    Object.entries(filters).forEach(([key, value]) => {
      query.set(key, String(value))
    })

    const queryString = query.toString()

    return request<T[]>(
      `${entityConfig.baseUrl}${entityConfig.resource}${
        queryString ? `?${queryString}` : ""
      }`,
    )
  },

  get<T extends EntityRecord>(
    entity: string,
    id: string | number,
  ): Promise<T> {
    const entityConfig = getEntityConfig(entity)

    return request<T>(
      `${entityConfig.baseUrl}${entityConfig.resource}/${id}`,
    )
  },

  create<T extends EntityRecord>(
    entity: string,
    data: EntityRecord,
  ): Promise<T> {
    const entityConfig = getEntityConfig(entity)

    return request<T>(
      `${entityConfig.baseUrl}${entityConfig.resource}`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    )
  },

  update<T extends EntityRecord>(
    entity: string,
    id: string | number,
    data: EntityRecord,
  ): Promise<T> {
    const entityConfig = getEntityConfig(entity)

    return request<T>(
      `${entityConfig.baseUrl}${entityConfig.resource}/${id}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    )
  },

  remove(entity: string, id: string | number): Promise<void> {
    const entityConfig = getEntityConfig(entity)

    return request<void>(
      `${entityConfig.baseUrl}${entityConfig.resource}/${id}`,
      {
        method: "DELETE",
      },
    )
  },

  getPrimaryKey(entity: string): string {
    return getEntityConfig(entity).primaryKey
  },
}
