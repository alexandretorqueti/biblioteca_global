// @vitest-environment jsdom
/**
 * Testes da lógica de renovação de token (tokenRefresh.ts).
 */
import { describe, expect, it, vi } from "vitest"
import {
  RENEW_MARGIN_SECONDS,
  TokenRefresher,
  createSessionRecovery,
  decodeAccessTokenExp,
  delayUntilRefreshMs,
} from "../tokenRefresh"
import { LocalTokenStore } from "../../api/tokenStore"

function jwtComExp(exp: number): string {
  return [
    "eyJhbGciOiJIUzI1NiJ9",
    btoa(JSON.stringify({ sub: 1, projetoId: 2, exp })),
    "sig",
  ].join(".")
}

describe("decodeAccessTokenExp", () => {
  it("decodifica o claim exp de um JWT válido", () => {
    expect(decodeAccessTokenExp(jwtComExp(1_800_000))).toBe(1_800_000)
  })

  it("retorna null para token malformado", () => {
    expect(decodeAccessTokenExp("invalido")).toBeNull()
    expect(decodeAccessTokenExp("a.b")).toBeNull()
  })

  it("retorna null quando não há exp", () => {
    const token = [`x`, btoa(JSON.stringify({ sub: 1 })), `y`].join(".")
    expect(decodeAccessTokenExp(token)).toBeNull()
  })
})

describe("delayUntilRefreshMs", () => {
  it("agenda com margem de segurança antes da expiração", () => {
    const agora = 1_000_000
    const esperado = (300 - RENEW_MARGIN_SECONDS) * 1000
    expect(delayUntilRefreshMs(agora + 300, agora)).toBe(esperado)
  })

  it("retorna null quando já na janela de segurança", () => {
    const agora = 1_000_000
    expect(delayUntilRefreshMs(agora + 30, agora)).toBeNull()
  })

  it("retorna null quando exp é desconhecido", () => {
    expect(delayUntilRefreshMs(null, 1_000_000)).toBeNull()
  })
})

describe("TokenRefresher", () => {
  it("agenda onRenew dentro da janela e cancela de forma idempotente", () => {
    const onRenew = vi.fn(async () => undefined)
    const agendadas: Array<{ cb: () => void; ms: number }> = []
    const runTimer = ((cb: () => void, ms: number) => {
      agendadas.push({ cb, ms })
      return agendadas.length
    }) as unknown as typeof setTimeout

    const refresher = new TokenRefresher({ onRenew, runTimer })
    const agora = 1_000_000
    refresher.schedule(() => agora + 300, agora)

    expect(agendadas).toHaveLength(1)
    expect(agendadas[0]!.ms).toBe((300 - RENEW_MARGIN_SECONDS) * 1000)

    agendadas[0]!.cb()
    expect(onRenew).toHaveBeenCalledTimes(1)

    refresher.cancel()
    refresher.cancel()
    expect(agendadas).toHaveLength(1)
  })

  it("não agenda quando o token não tem exp", () => {
    const onRenew = vi.fn(async () => undefined)
    const spy = vi.spyOn(globalThis, "setTimeout")

    const refresher = new TokenRefresher({ onRenew })
    refresher.schedule(() => null, 1_000_000)
    refresher.schedule(() => null, 2_000_000)

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("createSessionRecovery", () => {
  it("delega para a função de renovação", async () => {
    const renew = vi.fn(async () => true)
    const recovery = createSessionRecovery(renew)
    await expect(recovery()).resolves.toBe(true)
    expect(renew).toHaveBeenCalledTimes(1)
  })
})

describe("LocalTokenStore (integração com refresh)", () => {
  it("persiste e restaura o refresh token quando persistência está ativa", () => {
    localStorage.clear()
    const store = new LocalTokenStore(true)
    store.setRefreshToken("refresh-do-usuario")
    expect(store.getRefreshToken()).toBe("refresh-do-usuario")

    const outro = new LocalTokenStore(true)
    expect(outro.getRefreshToken()).toBe("refresh-do-usuario")

    outro.clear()
    expect(new LocalTokenStore(true).getRefreshToken()).toBeNull()
  })

  it("não persiste o access token (só o refresh, para 'lembrar de mim')", () => {
    localStorage.clear()
    const store = new LocalTokenStore(true)
    store.setAccessToken("access")
    store.setRefreshToken("refresh")

    const reinstantiated = new LocalTokenStore(true)
    expect(reinstantiated.getAccessToken()).toBeNull()
    expect(reinstantiated.getRefreshToken()).toBe("refresh")
  })
})
