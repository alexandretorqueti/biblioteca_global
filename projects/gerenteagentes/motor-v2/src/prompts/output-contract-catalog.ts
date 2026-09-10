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
  required: ["seq", "titulo", "scope", "acceptance_criteria", "deliverables", "requirements_covered", "depends_on"],
  properties: {
    seq: { type: "integer", minimum: 1 },
    titulo: { type: "string", minLength: 1 },
    scope: { type: "string", minLength: 1 },
    acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
    deliverables: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    requirements_covered: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    depends_on: { type: "array", items: { type: "integer", minimum: 1 } },
  },
}

export const OUTPUT_CONTRACT_CATALOG: readonly OutputContractDefault[] = [
  {
    key: "analista.plano_ou_perguntas",
    title: "Plano ou perguntas do analista",
    description: "Resposta da análise inicial e da retomada após esclarecimentos.",
    schema: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["subtarefas", "requirements", "coverage"], properties: { subtarefas: { type: "array", minItems: 1, maxItems: 10, items: subtask }, requirements: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "description"], properties: { id: { type: "string", pattern: "^REQ-[A-Z0-9_-]+$" }, description: { type: "string", minLength: 1 } } } }, coverage: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["requirement", "covered_by"], properties: { requirement: { type: "string" }, covered_by: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } } } } } } },
        { type: "object", additionalProperties: false, required: ["kind", "resumo", "perguntas"], properties: { kind: { const: "perguntas" }, resumo: { type: "string" }, perguntas: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } } } },
      ],
    },
    example: { subtarefas: [{ seq: 1, titulo: "Persistir dados e validar migração", scope: "Criar a persistência necessária e validar a migração no banco do projeto.", acceptance_criteria: ["Migration aplicada sem erro", "Dados persistidos podem ser lidos"], deliverables: ["migration", "teste de persistência"], requirements_covered: ["REQ-1"], depends_on: [] }], requirements: [{ id: "REQ-1", description: "Persistência do recurso" }], coverage: [{ requirement: "REQ-1", covered_by: [1] }] },
    instructions: 'CONVERSA NATURAL: Durante toda a clarificação, responda em texto livre — explicações, dúvidas e refinamentos são mensagens normais, não formulário. Não exija JSON nem perguntas numeradas do usuário. Só elabore a proposta de plano quando houver informação suficiente para cobrir integralmente o escopo. O JSON técnico do plano (subtarefas, requirements, coverage) é material interno para o Motor validar; inclua-o junto da proposta textual, nunca antes. É PROIBIDO criar subtarefas, iniciar execução ou materializar qualquer passo antes da aprovação explícita do dono. Quando faltar decisão, continue a conversa ou faça perguntas objetivas — ambas são respostas válidas. O JSON técnico do plano exige subtarefas detalhadas, requirements e coverage; cada subtarefa exige seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered e depends_on.',
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
