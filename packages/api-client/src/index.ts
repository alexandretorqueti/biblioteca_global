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
export { ActionExecutor } from "./action-executor"
export type {
  ActionPayload,
  ActionResult,
  ExecuteActionOptions,
} from "./action-executor"
export { createDataSource } from "./data-source"
export { ExternalApiClient } from "./external-client"
export type {
  ApiClientOptions,
  FetchFn,
  SessionRecovery,
  TokenStore,
} from "./types"
export { RealtimeClient } from "./realtime"
export type { RealtimeServerMessage } from "./realtime"
export type { RealtimeClientOptions } from "./types"
export { createAgentChatClient } from "./agent-chat-client"
export type {
  AgentChatClientOptions,
  AgentChatDriver,
  AgentChatEndpointConfig,
  AgentChatOutboxEntry,
} from "./agent-chat-client"
