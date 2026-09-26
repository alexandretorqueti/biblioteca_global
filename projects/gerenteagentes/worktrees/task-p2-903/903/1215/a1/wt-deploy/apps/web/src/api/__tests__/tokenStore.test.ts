// @vitest-environment jsdom
/**
 * Testes do LocalTokenStore — foco na hidratação após reload
 * (correção do "Restaurando sessão…" infinito, 2026-08-15).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { LocalTokenStore } from "../tokenStore"

const REFRESH_KEY = "bg.refreshToken"

beforeEach(() => {
  localStorage.clear()
})

describe("LocalTokenStore — hidratação (reload)", () => {
  it("inicializar com persist false NÃO apaga o refresh persistido", () => {
    localStorage.setItem(REFRESH_KEY, "refresh-persistido")
    const store = new LocalTokenStore()
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-persistido")
    expect(store.temRefreshPersistido()).toBe(true)
  })

  it("temRefreshPersistido detecta a presença no storage", () => {
    expect(new LocalTokenStore().temRefreshPersistido()).toBe(false)
    localStorage.setItem(REFRESH_KEY, "x")
    expect(new LocalTokenStore().temRefreshPersistido()).toBe(true)
  })

  it("setPersist(true) restaura o refresh do storage", () => {
    localStorage.setItem(REFRESH_KEY, "refresh-persistido")
    const store = new LocalTokenStore()
    store.setPersist(true)
    expect(store.getRefreshToken()).toBe("refresh-persistido")
  })

  it("setPersist(false) desliga e apaga do storage (logout/desligar)", () => {
    const store = new LocalTokenStore(true)
    store.setRefreshToken("refresh-atual")
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-atual")
    store.setPersist(false)
    expect(store.getRefreshToken()).toBe("refresh-atual") // memória preservada
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull() // storage limpo
  })

  it("fluxo de reload: refresh persistido sobrevive e é restaurável", () => {
    // Login com lembrar de mim.
    const sessao = new LocalTokenStore(true)
    sessao.setRefreshToken("refresh-1")
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")

    // Reload: store novo; a hidratação detecta e restaura.
    const aposReload = new LocalTokenStore()
    expect(aposReload.getRefreshToken()).toBeNull()
    expect(aposReload.temRefreshPersistido()).toBe(true)
    aposReload.setPersist(true)
    expect(aposReload.getRefreshToken()).toBe("refresh-1")
  })
})
