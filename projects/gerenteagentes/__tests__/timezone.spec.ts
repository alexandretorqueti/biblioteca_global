// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  getSupportedTimezones,
  resolveTimezone,
  formatarDataHora,
  hojeNoFuso,
  isHojeNoFuso,
  limitesDoDiaCivilUTC,
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

  describe("formatarDataHora", () => {
    it("formata ISO string em pt-BR no fuso informado", () => {
      // 2026-10-11T03:00:00Z = meia-noite em America/Sao_Paulo (UTC-3)
      const result = formatarDataHora("2026-10-11T03:00:00Z", "America/Sao_Paulo")
      expect(result).toMatch(/11\/10\/2026.*00:00/)
    })

    it("formata no fuso UTC quando especificado", () => {
      const result = formatarDataHora("2026-10-11T03:00:00Z", "UTC")
      expect(result).toMatch(/11\/10\/2026.*03:00/)
    })

    it("retorna string vazia para null/undefined/vazio", () => {
      expect(formatarDataHora(null)).toBe("")
      expect(formatarDataHora(undefined)).toBe("")
      expect(formatarDataHora("")).toBe("")
    })

    it("retorna string vazia para data inválida", () => {
      expect(formatarDataHora("not-a-date")).toBe("")
    })

    it("usa o fuso padrão quando timezone é inválido", () => {
      const result = formatarDataHora("2026-10-11T03:00:00Z", "Invalid/Zone")
      expect(result).toMatch(/11\/10\/2026.*00:00/) // America/Sao_Paulo
    })

    it("aceita Date e epoch ms", () => {
      const date = new Date("2026-10-11T03:00:00Z")
      expect(formatarDataHora(date, "America/Sao_Paulo")).toMatch(/11\/10\/2026.*00:00/)
      expect(formatarDataHora(date.getTime(), "America/Sao_Paulo")).toMatch(/11\/10\/2026.*00:00/)
    })
  })

  describe("hojeNoFuso", () => {
    it("retorna a data civil no fuso informado", () => {
      // 2026-10-11T02:00:00Z = 2026-10-10 23:00 em Sao Paulo (UTC-3)
      const agora = new Date("2026-10-11T02:00:00Z")
      expect(hojeNoFuso("America/Sao_Paulo", agora)).toBe("2026-10-10")
    })

    it("retorna a data civil em UTC", () => {
      const agora = new Date("2026-10-11T02:00:00Z")
      expect(hojeNoFuso("UTC", agora)).toBe("2026-10-11")
    })

    it("mesmo instante resulta em dias diferentes em fusos diferentes", () => {
      // 2026-10-11T01:00:00Z = 2026-10-10 22:00 em Sao Paulo, 2026-10-11 01:00 em UTC
      const agora = new Date("2026-10-11T01:00:00Z")
      expect(hojeNoFuso("America/Sao_Paulo", agora)).toBe("2026-10-10")
      expect(hojeNoFuso("UTC", agora)).toBe("2026-10-11")
    })
  })

  describe("isHojeNoFuso", () => {
    it("classifica corretamente perto da meia-noite em Sao Paulo", () => {
      // 2026-10-11T02:59:00Z = 2026-10-10 23:59 em Sao Paulo
      const agora = new Date("2026-10-11T02:59:00Z")
      const evento = "2026-10-10T23:30:00-03:00" // 2026-10-11T02:30:00Z
      // Evento é 10/10 23:30 em Sao Paulo; agora é 10/10 23:59 em Sao Paulo
      expect(isHojeNoFuso(evento, "America/Sao_Paulo", agora)).toBe(true)
    })

    it("detecta diferença de dia civil entre UTC e Sao Paulo", () => {
      // 2026-10-11T01:00:00Z = 2026-10-10 22:00 em Sao Paulo
      const agora = new Date("2026-10-11T01:00:00Z")
      const eventoUTC = "2026-10-11T00:30:00Z" // dia 11 em UTC
      // Em Sao Paulo, evento é 10/10 21:30 e agora é 10/10 22:00
      expect(isHojeNoFuso(eventoUTC, "America/Sao_Paulo", agora)).toBe(true)
      // Em UTC, evento é 11/10 00:30 e agora é 11/10 01:00
      expect(isHojeNoFuso(eventoUTC, "UTC", agora)).toBe(true)
    })

    it("retorna false para data em dia diferente", () => {
      const agora = new Date("2026-10-11T15:00:00Z")
      expect(isHojeNoFuso("2026-10-09T12:00:00Z", "America/Sao_Paulo", agora)).toBe(false)
    })

    it("retorna false para valores nulos/inválidos", () => {
      expect(isHojeNoFuso(null)).toBe(false)
      expect(isHojeNoFuso(undefined)).toBe(false)
      expect(isHojeNoFuso("")).toBe(false)
      expect(isHojeNoFuso("not-a-date")).toBe(false)
    })
  })

  describe("limitesDoDiaCivilUTC", () => {
    it("converte dia civil em Sao Paulo para limites UTC corretos", () => {
      // 2026-10-11 em America/Sao_Paulo (UTC-3):
      // inicio = 2026-10-11 00:00 -03:00 = 2026-10-11 03:00 UTC
      // fim    = 2026-10-12 00:00 -03:00 = 2026-10-12 03:00 UTC
      const { inicio, fim } = limitesDoDiaCivilUTC("2026-10-11", "America/Sao_Paulo")
      expect(inicio).toBe("2026-10-11 03:00:00")
      expect(fim).toBe("2026-10-12 03:00:00")
    })

    it("em UTC os limites coincidem com meia-noite UTC", () => {
      const { inicio, fim } = limitesDoDiaCivilUTC("2026-10-11", "UTC")
      expect(inicio).toBe("2026-10-11 00:00:00")
      expect(fim).toBe("2026-10-12 00:00:00")
    })

    it("fusos positivos (leste) deslocam para o dia anterior em UTC", () => {
      // 2026-10-11 em Asia/Tokyo (UTC+9):
      // inicio = 2026-10-11 00:00 +09:00 = 2026-10-10 15:00 UTC
      // fim    = 2026-10-12 00:00 +09:00 = 2026-10-11 15:00 UTC
      const { inicio, fim } = limitesDoDiaCivilUTC("2026-10-11", "Asia/Tokyo")
      expect(inicio).toBe("2026-10-10 15:00:00")
      expect(fim).toBe("2026-10-11 15:00:00")
    })

    it("usa o fuso padrão quando timezone é inválido", () => {
      const { inicio, fim } = limitesDoDiaCivilUTC("2026-10-11", "Invalid/Zone")
      expect(inicio).toBe("2026-10-11 03:00:00")
      expect(fim).toBe("2026-10-12 03:00:00")
    })
  })
})
