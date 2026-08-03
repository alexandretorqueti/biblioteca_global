import { entityApi, type EntityRecord } from "../api/entityApi"

export interface EntityController<T extends EntityRecord> {
  list(): Promise<T[]>
  get(id: string | number): Promise<T>
  create(data: Omit<T, "id"> | EntityRecord): Promise<T>
  update(id: string | number, data: Partial<T>): Promise<T>
  remove(id: string | number): Promise<void>
  primaryKey: string
}

export const createEntityController = <
  T extends EntityRecord,
>(
  entity: string,
): EntityController<T> => ({
  primaryKey: entityApi.getPrimaryKey(entity),

  list() {
    return entityApi.list<T>(entity)
  },

  get(id) {
    return entityApi.get<T>(entity, id)
  },

  create(data) {
    return entityApi.create<T>(entity, data)
  },

  update(id, data) {
    return entityApi.update<T>(entity, id, data)
  },

  remove(id) {
    return entityApi.remove(entity, id)
  },
})
