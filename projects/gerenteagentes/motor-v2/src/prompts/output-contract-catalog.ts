export interface OutputContractDefault {
  key: string
  title: string
  description: string
  schema: Record<string, unknown>
  example: unknown
  instructions: string
}

const subtask = {
  type: "object",
  additionalProperties: false,
  required: ["seq", "titulo", "scope", "acceptance_criteria"],
  properties: {
    seq: { type: "integer", minimum: 1 },
    titulo: { type: "string", minLength: 1 },
    scope: { type: "string", minLength: 1 },
    acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
  },
}

export const OUTPUT_CONTRACT_CATALOG: readonly OutputContractDefault[] = [
  {
    key: "analista.plano_ou_perguntas",
    title: "Plano ou perguntas do analista",
    description: "Resposta da análise inicial e da retomada após esclarecimentos.",
    schema: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["subtarefas"], properties: { subtarefas: { type: "array", minItems: 1, maxItems: 10, items: subtask } } },
        { type: "object", additionalProperties: false, required: ["kind", "resumo", "perguntas"], properties: { kind: { const: "perguntas" }, resumo: { type: "string" }, perguntas: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } } } },
      ],
    },
    example: { subtarefas: [{ seq: 1, titulo: "Implementar alteração", scope: "Alterar o componente necessário.", acceptance_criteria: ["Comportamento validado"] }] },
    instructions: 'Responda somente com JSON. Quando estiver claro, use {"subtarefas":[{"seq":1,"titulo":"...","scope":"...","acceptance_criteria":["..."]}]}. Quando faltar decisão, use {"kind":"perguntas","resumo":"...","perguntas":["..."]}.',
  },
  {
    key: "dev.resultado_execucao",
    title: "Resultado do desenvolvedor",
    description: "Resultado normal, bloqueio ou refutação fundamentada.",
    schema: { type: "object", required: ["status", "summary"], properties: { status: { enum: ["done", "need_help", "blocked_environment", "premise_incorrect"] }, summary: { type: "string" }, reason: { type: "string" }, claim: { type: "string" }, conflict_type: { type: "string" }, evidence: { type: "array", items: { type: "object", required: ["path", "observation"] } }, suggested_revision: { type: "string" } } },
    example: { status: "done", summary: "Alteração implementada e verificada." },
    instructions: 'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect","summary":"...","reason":"..."}. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.',
  },
  {
    key: "monitor.veredito_gate",
    title: "Veredito de falha do gate",
    description: "Classificação estruturada da causa de uma falha de gate.",
    schema: { type: "object", required: ["verdict", "analysis"], properties: { verdict: { enum: ["agent_can_solve", "code_files_issue", "test_files_issue", "motor_issue"] }, analysis: { type: "string" }, solution: { type: "string" } } },
    example: { verdict: "agent_can_solve", analysis: "Falha localizada na implementação." },
    instructions: 'Responda somente com JSON: {"verdict":"agent_can_solve|code_files_issue|test_files_issue|motor_issue","analysis":"...","solution":"..."}.',
  },
]

export function outputContractDefault(key: string | undefined): OutputContractDefault | undefined {
  return key ? OUTPUT_CONTRACT_CATALOG.find((item) => item.key === key) : undefined
}
