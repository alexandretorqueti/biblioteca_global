// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  getSupportedTimezones,
  resolveTimezone,
} from "../src/shared/timezone"

describe("utilitários de fuso horário", () => {
  describe("DEFAULT_TIMEZONE", () => {
    it("é America/Sao_Paulo", () => {
      expect(DEFAULT_TIMEZONE).toBe("America/Sao_Paulo")
    })

    it("é um fuso horário válido", () => {
      expect(isValidTimezone(DEFAULT_TIMEZONE)).toBe(true)
    })
  })

  describe("isValidTimezone", () => {
    it("aceita identificadores IANA válidos", () => {
      expect(isValidTimezone("America/Sao_Paulo")).toBe(true)
      expect(isValidTimezone("America/New_York")).toBe(true)
      expect(isValidTimezone("Europe/London")).toBe(true)
      expect(isValidTimezone("Asia/Tokyo")).toBe(true)
      expect(isValidTimezone("UTC")).toBe(true)
    })

    it("rejeita strings vazias, null, undefined e não-strings", () => {
      expect(isValidTimezone("")).toBe(false)
      expect(isValidTimezone(null)).toBe(false)
      expect(isValidTimezone(undefined)).toBe(false)
      expect(isValidTimezone(42)).toBe(false)
      expect(isValidTimezone(true)).toBe(false)
    })

    it("rejeita identificadores inválidos", () => {
      expect(isValidTimezone("Invalid/Zone")).toBe(false)
      expect(isValidTimezone("Not_A_Zone")).toBe(false)
      expect(isValidTimezone("America/Invalid_City")).toBe(false)
      expect(isValidTimezone("foo")).toBe(false)
    })
  })

  describe("getSupportedTimezones", () => {
    it("retorna array não-vazio de strings", () => {
      const list = getSupportedTimezones()
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBeGreaterThan(0)
      expect(list.every((tz) => typeof tz === "string")).toBe(true)
    })

    it("inclui o fuso padrão", () => {
      const list = getSupportedTimezones()
      expect(list).toContain(DEFAULT_TIMEZONE)
    })

    it("todos os itens são fusos válidos", () => {
      const list = getSupportedTimezones()
      for (const tz of list) {
        expect(isValidTimezone(tz)).toBe(true)
      }
    })
  })

  describe("resolveTimezone", () => {
    it("retorna o valor persistido quando válido", () => {
      expect(resolveTimezone("America/New_York")).toBe("America/New_York")
      expect(resolveTimezone("Europe/London")).toBe("Europe/London")
    })

    it("retorna o padrão quando o valor é inválido ou ausente", () => {
      expect(resolveTimezone(null)).toBe(DEFAULT_TIMEZONE)
      expect(resolveTimezone(undefined)).toBe(DEFAULT_TIMEZONE)
      expect(resolveTimezone("")).toBe(DEFAULT_TIMEZONE)
      expect(resolveTimezone("Invalid/Zone")).toBe(DEFAULT_TIMEZONE)
      expect(resolveTimezone(42)).toBe(DEFAULT_TIMEZONE)
    })
  })
})
