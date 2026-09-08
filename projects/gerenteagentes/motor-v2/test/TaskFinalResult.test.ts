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
})
