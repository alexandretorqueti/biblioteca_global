/**
 * @biblioteca-global/api-client — única camada do front que fala HTTP
 * (PoC §3/§7.4). Token injetado automaticamente; projetoId nunca sai do
 * cliente.
 */
export { ApiClientError } from "./errors"
export {
  ApiHttpClient,
  assertSemProjetoId,
  type AuthMode,
  type RequestOptions,
} from "./http"
export { AuthClient } from "./auth-client"
export { RestEntityClient } from "./entity-client"
export { createDataSource } from "./data-source"
export type {
  ApiClientOptions,
  FetchFn,
  SessionRecovery,
  TokenStore,
} from "./types"
