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
        { type: "object", additionalProperties: false, required: ["kind", "verdict", "summary", "evidence"], properties: { kind: { enum: ["verification", "verificacao"] }, verdict: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, evidence: { type: "array", items: { type: "string" } } } },
        { type: "object", additionalProperties: false, required: ["subtarefas", "requirements", "coverage"], properties: { subtarefas: { type: "array", minItems: 1, maxItems: 10, items: subtask }, requirements: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "description"], properties: { id: { type: "string", pattern: "^REQ-[A-Z0-9_-]+$" }, description: { type: "string", minLength: 1 } } } }, coverage: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["requirement", "covered_by"], properties: { requirement: { type: "string" }, covered_by: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } } } } } } },
        { type: "object", additionalProperties: false, required: ["kind", "resumo", "perguntas"], properties: { kind: { const: "perguntas" }, resumo: { type: "string" }, perguntas: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } } } },
      ],
    },
    example: { kind: "verification", verdict: "Confirmado", summary: "Avaliacao concluida diretamente pelo Analista.", evidence: ["Comando ou artefato consultado"] },
    instructions: 'Responda somente com JSON. Para tarefa do tipo verificacao clara, faça a verificação diretamente, sem criar subtarefas: use {"kind":"verification","verdict":"...","summary":"...","evidence":["..."]}. Se faltar decisão ou houver ambiguidade, use {"kind":"perguntas","resumo":"...","perguntas":["..."]}. Para os demais tipos, um plano exige subtarefas detalhadas e os campos requirements e coverage.',
  },
  {
    key: "dev.resultado_execucao",
    title: "Resultado do desenvolvedor",
    description: "Resultado normal, bloqueio, esclarecimento, refutação ou operação de banco fundamentada.",
    schema: { type: "object", required: ["status", "summary"], properties: { status: { enum: ["done", "need_help", "blocked_environment", "premise_incorrect", "database_operation"] }, summary: { type: "string" }, reason: { type: "string" }, question: { type: "string", description: "Obrigatório e objetivo quando status=need_help" }, script_path: { type: "string" }, claim: { type: "string" }, conflict_type: { type: "string" }, evidence: { type: "array", items: { type: "object", required: ["path", "observation"] } }, suggested_revision: { type: "string" } } },
    example: { status: "done", summary: "Alteração implementada e verificada." },
    instructions: 'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect|database_operation","summary":"...","reason":"...","question":"..."}. Quando status=need_help, question é obrigatório e deve ser uma pergunta objetiva que o responsável possa responder; nunca use somente "nenhum arquivo foi alterado". Se a tarefa exigir mudança ou importação de dados, crie uma migration .sql UTF-8 dentro do diretório de migrations do projeto. NUNCA abra conexão MySQL/TCP, procure credenciais ou execute SQL. Responda {"status":"database_operation","summary":"...","script_path":"caminho/relativo da migration"}. A migration será revisada e aplicada no fluxo de deploy. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.',
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
