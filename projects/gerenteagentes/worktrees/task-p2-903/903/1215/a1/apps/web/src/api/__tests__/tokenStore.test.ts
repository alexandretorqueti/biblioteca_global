// @vitest-environment jsdom
/**
 * Testes do LocalTokenStore — foco na hidratação após reload
 * (correção do "Restaurando sessão…" infinito, 2026-08-15).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { LocalTokenStore } from "../tokenStore"

const REFRESH_KEY = "bg.refreshToken"
const PROJETO_KEY = "bg.projetoId"

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

describe("LocalTokenStore — projetoId (UX)", () => {
  it("setProjetoId grava na chave bg.projetoId e getProjetoId lê", () => {
    const store = new LocalTokenStore()
    expect(store.getProjetoId()).toBeNull()
    store.setProjetoId("640")
    expect(store.getProjetoId()).toBe("640")
    expect(localStorage.getItem(PROJETO_KEY)).toBe("640")
  })

  it("getProjetoId retorna null quando não há valor persistido", () => {
    expect(new LocalTokenStore().getProjetoId()).toBeNull()
  })

  it("setProjetoId(null) remove a chave do storage", () => {
    const store = new LocalTokenStore()
    store.setProjetoId("640")
    store.setProjetoId(null)
    expect(store.getProjetoId()).toBeNull()
    expect(localStorage.getItem(PROJETO_KEY)).toBeNull()
  })

  it("clear() remove bg.projetoId junto com as demais chaves", () => {
    const store = new LocalTokenStore(true)
    store.setRefreshToken("refresh-1")
    store.setProjetoId("640")
    expect(localStorage.getItem(PROJETO_KEY)).toBe("640")
    store.clear()
    expect(localStorage.getItem(PROJETO_KEY)).toBeNull()
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
    expect(store.getProjetoId()).toBeNull()
    expect(store.getRefreshToken()).toBeNull()
    expect(store.getAccessToken()).toBeNull()
  })

  it("setPersist(false) NÃO apaga o projetoId (é UX, não sessão)", () => {
    const store = new LocalTokenStore(true)
    store.setRefreshToken("refresh-1")
    store.setProjetoId("640")
    expect(localStorage.getItem(PROJETO_KEY)).toBe("640")

    store.setPersist(false)
    // refresh foi apagado do storage (sessão)
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
    // projetoId permanece (UX — sobrevive ao desligar 'lembrar de mim')
    expect(localStorage.getItem(PROJETO_KEY)).toBe("640")
    expect(store.getProjetoId()).toBe("640")
  })

  it("projetoId sobrevive a reload (nova instância)", () => {
    const store1 = new LocalTokenStore()
    store1.setProjetoId("640")

    const store2 = new LocalTokenStore()
    expect(store2.getProjetoId()).toBe("640")
  })

  it("access token NUNCA vai a localStorage (invariante de segurança)", () => {
    const store = new LocalTokenStore(true)
    store.setAccessToken("access-secreto")
    expect(localStorage.getItem("bg.accessToken")).toBeNull()
    // nenhuma chave de access em nenhum lugar
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      expect(key).not.toContain("access")
    }
  })
})
