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

describe("TaskFinalResult — fluxo completo de verificação", () => {
  const subtasks = [
    { seq: 1, titulo: "Validar schema do banco", resultado: JSON.stringify({ status: "done", summary: "Todas as 12 tabelas íntegras", reason: "" }) },
    { seq: 2, titulo: "Verificar endpoints da API", resultado: JSON.stringify({ status: "done", summary: "8/8 endpoints respondendo 200", reason: "Healthcheck OK" }) },
    { seq: 3, titulo: "Conferir permissões de acesso", resultado: JSON.stringify({ status: "done", summary: "RBAC configurado corretamente", reason: "" }) },
  ]

  it("consolida todas as subtarefas de verificação em resultado único done", () => {
    const result = consolidateTaskFinalResult("verificacao", subtasks)!
    expect(result).toBeDefined()
    expect(result.status).toBe("done")
    expect(result.summary).toContain("Subtarefa 1")
    expect(result.summary).toContain("Subtarefa 2")
    expect(result.summary).toContain("Subtarefa 3")
    expect(result.summary).toContain("Todas as 12 tabelas íntegras")
    expect(result.summary).toContain("8/8 endpoints respondendo 200")
    expect(result.summary).toContain("RBAC configurado corretamente")
  })

  it("gera texto de chat legível a partir do resultado consolidado de verificação", () => {
    const result = consolidateTaskFinalResult("verificacao", subtasks)!
    const chatText = finalResultChatText(result)
    expect(chatText).toContain("Subtarefa 1")
    expect(chatText).toContain("Healthcheck OK")
    expect(typeof chatText).toBe("string")
    expect(chatText.length).toBeGreaterThan(0)
  })

  it("propaga blocked_environment quando qualquer subtarefa de verificação bloqueia", () => {
    const subtasksComBloqueio = [
      { seq: 1, titulo: "Validar schema", resultado: JSON.stringify({ status: "done", summary: "OK", reason: "" }) },
      { seq: 2, titulo: "Verificar banco", resultado: JSON.stringify({ status: "blocked_environment", summary: "Banco indisponível", reason: "Conexão recusada na porta 3306" }) },
    ]
    const result = consolidateTaskFinalResult("verificacao", subtasksComBloqueio)!
    expect(result.status).toBe("blocked_environment")
    expect(result.reason).toContain("Conexão recusada na porta 3306")
  })

  it("preserva evidências individuais das subtarefas após consolidação", () => {
    // As subtarefas originais NÃO são modificadas pela consolidação
    const subtasksOriginais = subtasks.map((s) => ({ ...s }))
    consolidateTaskFinalResult("verificacao", subtasksOriginais)
    // Cada subtarefa mantém seu resultado original intacto
    for (let i = 0; i < subtasks.length; i++) {
      expect(subtasksOriginais[i]!.resultado).toBe(subtasks[i]!.resultado)
      expect(subtasksOriginais[i]!.titulo).toBe(subtasks[i]!.titulo)
      expect(subtasksOriginais[i]!.seq).toBe(subtasks[i]!.seq)
    }
  })
})

describe("TaskFinalResult — fluxo completo de automação", () => {
  const subtasks = [
    { seq: 1, titulo: "Configurar pipeline CI", resultado: JSON.stringify({ status: "done", summary: "Pipeline criado com 3 stages", reason: "" }) },
    { seq: 2, titulo: "Automatizar deploy em staging", resultado: JSON.stringify({ status: "done", summary: "Deploy automático configurado", reason: "Script deploy.sh criado" }) },
    { seq: 3, titulo: "Configurar rollback automático", resultado: JSON.stringify({ status: "need_help", summary: "Rollback parcial", reason: "Faltam credenciais do ambiente de produção" }) },
  ]

  it("consolida subtarefas de automação com status need_help", () => {
    const result = consolidateTaskFinalResult("automacao", subtasks)!
    expect(result).toBeDefined()
    expect(result.status).toBe("need_help")
    expect(result.summary).toContain("Subtarefa 1")
    expect(result.summary).toContain("Subtarefa 2")
    expect(result.summary).toContain("Subtarefa 3")
    expect(result.summary).toContain("Pipeline criado com 3 stages")
    expect(result.summary).toContain("Deploy automático configurado")
    expect(result.summary).toContain("Rollback parcial")
  })

  it("gera texto de chat com motivo para automação need_help", () => {
    const result = consolidateTaskFinalResult("automacao", subtasks)!
    const chatText = finalResultChatText(result)
    expect(chatText).toContain("Motivo:")
    expect(chatText).toContain("Faltam credenciais do ambiente de produção")
  })

  it("preserva evidências individuais das subtarefas de automação após consolidação", () => {
    const subtasksOriginais = subtasks.map((s) => ({ ...s }))
    consolidateTaskFinalResult("automacao", subtasksOriginais)
    for (let i = 0; i < subtasks.length; i++) {
      expect(subtasksOriginais[i]!.resultado).toBe(subtasks[i]!.resultado)
      expect(subtasksOriginais[i]!.titulo).toBe(subtasks[i]!.titulo)
      expect(subtasksOriginais[i]!.seq).toBe(subtasks[i]!.seq)
    }
  })

  it("automação com todas subtarefas done resulta em status done", () => {
    const subtasksOk = [
      { seq: 1, titulo: "Configurar pipeline", resultado: JSON.stringify({ status: "done", summary: "OK", reason: "" }) },
      { seq: 2, titulo: "Deploy automático", resultado: JSON.stringify({ status: "done", summary: "OK", reason: "" }) },
    ]
    const result = consolidateTaskFinalResult("automacao", subtasksOk)!
    expect(result.status).toBe("done")
    expect(result.reason).toBe("")
  })

  it("automação blocked_environment prevalece sobre need_help", () => {
    const subtasksMistas = [
      { seq: 1, titulo: "Etapa A", resultado: JSON.stringify({ status: "need_help", summary: "Precisa ajuda", reason: "Falta config" }) },
      { seq: 2, titulo: "Etapa B", resultado: JSON.stringify({ status: "blocked_environment", summary: "Ambiente fora", reason: "Servidor fora do ar" }) },
    ]
    const result = consolidateTaskFinalResult("automacao", subtasksMistas)!
    expect(result.status).toBe("blocked_environment")
  })
})

describe("TaskFinalResult — persistência e API (formato serializável)", () => {
  it("resultado consolidado é serializável como JSON (persistência)", () => {
    const result = consolidateTaskFinalResult("verificacao", [
      { seq: 1, titulo: "Teste", resultado: JSON.stringify({ status: "done", summary: "OK", reason: "" }) },
    ])
    const serialized = JSON.stringify(result)
    const parsed = JSON.parse(serialized)
    expect(parsed.status).toBe("done")
    expect(typeof parsed.summary).toBe("string")
    expect(typeof parsed.reason).toBe("string")
  })

  it("resultado consolidado para automação é serializável como JSON", () => {
    const result = consolidateTaskFinalResult("automacao", [
      { seq: 1, titulo: "Deploy", resultado: JSON.stringify({ status: "done", summary: "Deploy OK", reason: "Pipeline verde" }) },
    ])
    const serialized = JSON.stringify(result)
    const parsed = JSON.parse(serialized)
    expect(parsed.status).toBe("done")
    expect(parsed.summary).toContain("Deploy OK")
    expect(parsed.reason).toContain("Pipeline verde")
  })

  it("texto do chat é determinístico (mesma entrada → mesma saída)", () => {
    const subtasks = [
      { seq: 1, titulo: "Validar", resultado: JSON.stringify({ status: "done", summary: "Tudo OK", reason: "Sem erros" }) },
    ]
    const result1 = consolidateTaskFinalResult("verificacao", subtasks)!
    const result2 = consolidateTaskFinalResult("verificacao", subtasks)!
    expect(finalResultChatText(result1)).toBe(finalResultChatText(result2))
  })
})
