import type { ListParams, LogsLoginPage } from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export class LogsLoginClient {
  constructor(private readonly http: ApiHttpClient) {}

  list(params: ListParams = {}): Promise<LogsLoginPage> {
    return this.http.request<LogsLoginPage>("GET", "/logs-login", {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        search: params.search,
      },
      auth: "access",
    })
  }
}

export function createLogsLoginClient(http: ApiHttpClient): LogsLoginClient {
  return new LogsLoginClient(http)
}
