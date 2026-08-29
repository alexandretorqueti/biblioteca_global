import { describe, expect, it, vi } from "vitest"
import { WsAdapter } from "@nestjs/platform-ws"
import { configureApp } from "../bootstrap"

describe("bootstrap da API", () => {
  it("configura o adaptador WebSocket ws, sem depender de Socket.IO", () => {
    const app = {
      useWebSocketAdapter: vi.fn(),
      setGlobalPrefix: vi.fn(),
      enableCors: vi.fn(),
      useGlobalPipes: vi.fn(),
    }

    configureApp(app as never)

    expect(app.useWebSocketAdapter).toHaveBeenCalledTimes(1)
    expect(app.useWebSocketAdapter.mock.calls[0]?.[0]).toBeInstanceOf(WsAdapter)
  })
})
