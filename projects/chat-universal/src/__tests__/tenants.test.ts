import { describe, expect, it } from "vitest"
import { alphaTenant } from "../tenants/alpha"
import { isaTenant } from "../tenants/isa"
import { resolveTenant, tenants } from "../tenants"
import { applyTenantScope, getVisitorKey } from "../App"

describe("chat-universal tenants", () => {
  it.each([
    ["isa.globaltecnologia.net", "isa"], ["isa.webconnect.com.br", "isa"],
    ["alpha.globaltecnologia.net", "alpha"], ["alpha.webconnect.com.br", "alpha"],
  ])("resolve %s as %s", (host, expected) => expect(resolveTenant(host)).toBe(expected))

  it("prioritizes the explicit query override and rejects unknown hosts", () => {
    expect(resolveTenant("unknown.example", "isa")).toBe("isa")
    expect(resolveTenant("unknown.example", "alpha")).toBe("alpha")
    expect(resolveTenant("unknown.example")).toBeUndefined()
    expect(resolveTenant("isa.globaltecnologia.net", "other")).toBe("isa")
  })

  it("keeps exact tenant invariants and payload differences", () => {
    expect(Object.keys(tenants)).toEqual(["isa", "alpha"])
    expect(isaTenant.storage).toEqual({ chatId: "isa.chatId", loginEmail: "isa.loginEmail" })
    expect(alphaTenant.storage).toEqual({ chatId: "alpha.chatId", loginEmail: "alpha.loginEmail" })
    expect(isaTenant.buildSessionBody("key")).toEqual({ chatKey: "key" })
    expect(alphaTenant.buildSessionBody("key")).toEqual({ chatKey: "key", agentId: "alpha" })
    expect(isaTenant.buildSendBody({ chatId: "id", text: "oi" })).not.toHaveProperty("agentId")
    expect(alphaTenant.buildSendBody({ chatId: "id", text: "oi" })).toMatchObject({ agentId: "alpha" })
    expect(isaTenant.primary).toBe("#003366")
    expect(alphaTenant.secondary).toBe("#c9a961")
    expect(isaTenant.welcomeMessage).toContain("Sou a Isa")
    expect(alphaTenant.welcomeMessage).toContain("Sou a Alpha")
  })

  it("reuses the existing visitor key", () => {
    const storage = new Map<string, string>()
    const original = window.localStorage
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
    storage.set("isa.chatId", "visitor-existing")
    expect(getVisitorKey("isa.chatId")).toBe("visitor-existing")
    expect(getVisitorKey("alpha.chatId")).toMatch(/^visitor-/)
    Object.defineProperty(window, "localStorage", { configurable: true, value: original })
  })

  it("scopes the Alpha class to html and body and cleans it up", () => {
    const cleanupAlpha = applyTenantScope("alpha")
    expect(document.documentElement.classList.contains("tenant-alpha")).toBe(true)
    expect(document.body.classList.contains("tenant-alpha")).toBe(true)

    const cleanupIsa = applyTenantScope("isa")
    expect(document.documentElement.classList.contains("tenant-alpha")).toBe(false)
    expect(document.body.classList.contains("tenant-alpha")).toBe(false)

    cleanupIsa()
    cleanupAlpha()
    expect(document.documentElement.classList.contains("tenant-alpha")).toBe(false)
    expect(document.body.classList.contains("tenant-alpha")).toBe(false)
  })

})
