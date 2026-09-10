/**
 * Testes do fingerprint estável de gates.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest"
import { stableGateFingerprint, classifyGateType } from "../src/policies/GateFingerprint.js"

describe("GateFingerprint", () => {
  describe("stableGateFingerprint", () => {
    it("gera fingerprint determinístico para mesma entrada", () => {
      const fp1 = stableGateFingerprint("build", "TS2345: Type error in file.ts")
      const fp2 = stableGateFingerprint("build", "TS2345: Type error in file.ts")
      expect(fp1).toBe(fp2)
    })

    it("gera fingerprints diferentes para erros diferentes", () => {
      const fp1 = stableGateFingerprint("build", "TS2345: Type error")
      const fp2 = stableGateFingerprint("build", "TS2322: Assignment error")
      expect(fp1).not.toBe(fp2)
    })

    it("gera fingerprints diferentes para gates diferentes com mesmo erro", () => {
      const fp1 = stableGateFingerprint("build", "Error: something failed")
      const fp2 = stableGateFingerprint("test_unit", "Error: something failed")
      expect(fp1).not.toBe(fp2)
    })

    it("normaliza caminhos absolutos do worktree", () => {
      const fp1 = stableGateFingerprint("build", "Error at /data/workspace/projects/agentes/x/worktrees/t/1/a1/file.ts:10")
      const fp2 = stableGateFingerprint("build", "Error at /data/workspace/projects/agentes/y/worktrees/t/2/a2/file.ts:10")
      expect(fp1).toBe(fp2)
    })

    it("normaliza caminhos de /home", () => {
      const fp1 = stableGateFingerprint("build", "ENOENT /home/user/project/file.ts")
      const fp2 = stableGateFingerprint("build", "ENOENT /home/other/project/file.ts")
      expect(fp1).toBe(fp2)
    })

    it("normaliza timestamps ISO", () => {
      const fp1 = stableGateFingerprint("test_unit", "Timeout at 2026-09-10T10:00:00Z")
      const fp2 = stableGateFingerprint("test_unit", "Timeout at 2026-09-10T11:30:00Z")
      expect(fp1).toBe(fp2)
    })

    it("normaliza durações", () => {
      const fp1 = stableGateFingerprint("test_unit", "Test took 1234ms")
      const fp2 = stableGateFingerprint("test_unit", "Test took 5678ms")
      expect(fp1).toBe(fp2)
    })

    it("normaliza UUIDs", () => {
      const fp1 = stableGateFingerprint("build", "Session abc12345-1234-1234-1234-123456789abc failed")
      const fp2 = stableGateFingerprint("build", "Session def67890-5678-5678-5678-abcdef012345 failed")
      expect(fp1).toBe(fp2)
    })

    it("limita o tamanho do fingerprint", () => {
      const longMessage = "Error: " + "x".repeat(1000)
      const fp = stableGateFingerprint("build", longMessage)
      expect(fp.length).toBeLessThanOrEqual(128)
    })

    it("inclui o tipo do gate no prefixo", () => {
      const fp = stableGateFingerprint("smoke_test", "curl failed")
      expect(fp).toMatch(/^smoke_test:/)
    })
  })

  describe("classifyGateType", () => {
    it("classifica comandos de build", () => {
      expect(classifyGateType("npm run build")).toBe("build")
      expect(classifyGateType("npx tsc --noEmit")).toBe("build")
    })

    it("classifica comandos de teste unitário", () => {
      expect(classifyGateType("npm run test")).toBe("test_unit")
      expect(classifyGateType("npx vitest run")).toBe("test_unit")
    })

    it("classifica comandos de teste E2E", () => {
      expect(classifyGateType("npm run test:e2e")).toBe("test_e2e")
      expect(classifyGateType("npx playwright test")).toBe("test_e2e")
    })

    it("classifica comandos de lint", () => {
      expect(classifyGateType("npm run lint")).toBe("lint")
      expect(classifyGateType("npx eslint src/")).toBe("lint")
    })

    it("classifica smoke test", () => {
      expect(classifyGateType("curl http://localhost:3000/api/health")).toBe("smoke_test")
      expect(classifyGateType("npm run smoke-test")).toBe("smoke_test")
    })

    it("classifica security audit", () => {
      expect(classifyGateType("npm audit")).toBe("security")
    })

    it("retorna custom para comandos não reconhecidos", () => {
      expect(classifyGateType("./custom-script.sh")).toBe("custom")
    })
  })
})
