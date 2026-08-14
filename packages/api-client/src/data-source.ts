/**
 * Adaptador RestEntityClient → CadastroDataSource (contrato da tela
 * Cadastro da UI — PoC §7.4). A UI recebe o dataSource pronto e nunca
 * fala HTTP.
 */
import type {
  CadastroDataSource,
  EntityRecord,
} from "@biblioteca-global/shared"
import { RestEntityClient } from "./entity-client"
import type { ApiHttpClient } from "./http"

function idDe(row: EntityRecord): string | number {
  const id = row.id
  if (typeof id === "number" || typeof id === "string") {
    return id
  }
  throw new Error("registro sem campo id — impossível montar o dataSource")
}

/** Limite da listagem única da tela Cadastro (paginação fica p/ grid). */
const LIMITE_LISTAGEM = 500

export function createDataSource<T extends EntityRecord>(
  http: ApiHttpClient,
  resource: string,
): CadastroDataSource<T> {
  const client = new RestEntityClient<T>(http, resource)
  return {
    list: async () => {
      const pagina = await client.list({ pageSize: LIMITE_LISTAGEM })
      return pagina.items
    },
    create: (values) => client.create(values),
    update: (row, values) => client.update(idDe(row), values),
    remove: async (row) => {
      await client.remove(idDe(row))
    },
    getRowId: (row) => idDe(row),
  }
}
