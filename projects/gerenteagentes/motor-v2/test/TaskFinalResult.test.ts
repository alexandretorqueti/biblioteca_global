import { describe, expect, it } from "vitest"
import { consolidateTaskFinalResult, finalResultChatText } from "../src/policies/TaskFinalResult.js"

describe("TaskFinalResult", () => {
  it("consolida verificação", () => {
    const result = consolidateTaskFinalResult("verificacao", [{ seq: 1, titulo: "Validar API", resultado: '{"status":"done","summary":"API respondeu 200","reason":""}' }])!
    expect(result.status).toBe("done")
    expect(finalResultChatText(result)).toContain("API respondeu 200")
  })
  it("consolida automação e propaga necessidade de ajuda", () => {
    const result = consolidateTaskFinalResult("automacao", [{ seq: 1, titulo: "Executar rotina", resultado: '{"status":"need_help","summary":"Interrompida","reason":"Credencial ausente"}' }])!
    expect(result.status).toBe("need_help")
    expect(result.reason).toContain("Credencial ausente")
  })
  it("ignora desenvolvimento", () => expect(consolidateTaskFinalResult("desenvolvimento", [])).toBeNull())

  it("mantém chat e persistência com o mesmo texto consolidado", () => {
    const result = consolidateTaskFinalResult("verificacao", [
      { seq: 1, titulo: "Verificar limite", resultado: JSON.stringify({ status: "done", summary: "x".repeat(40_000), reason: "y".repeat(20_000) }) },
    ])!
    const chat = finalResultChatText(result)
    expect(chat).toBe(`${result.summary}\n\nMotivo: ${result.reason}`)
    expect(result.summary).toContain("[texto consolidado truncado]")
    expect(result.reason).toContain("[texto consolidado truncado]")
  })
})
