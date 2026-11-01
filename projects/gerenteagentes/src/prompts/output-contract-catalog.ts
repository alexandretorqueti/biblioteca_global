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

const macroTask = {
  type: "object",
  additionalProperties: false,
  required: ["seq", "titulo", "objetivo", "escopo", "aceite", "requisitos", "executor", "depende_de", "auto_start", "risco"],
  properties: {
    seq: { type: "integer", minimum: 1 },
    titulo: { type: "string", minLength: 1 },
    objetivo: { type: "string", minLength: 1 },
    escopo: { type: "string", minLength: 1 },
    aceite: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    requisitos: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    executor: { enum: ["biblioteca-global", "agente-projeto"] },
    depende_de: { type: "array", items: { type: "integer", minimum: 1 } },
    auto_start: { type: "boolean" },
    risco: { enum: ["baixo", "medio", "alto"] },
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
    key: "geracao.plano_ou_perguntas",
    title: "Plano macro ou perguntas da geração de projeto",
    description: "Resposta da Geração Macro de tarefas (spec → plano → aprovação): plano de tarefas macro revisável ou perguntas de clarificação, conforme §5 de docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md.",
    schema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "classificacaoSistema", "requerAgenteDedicado", "requisitos", "especificacaoCrud", "tarefas", "matrizCobertura", "lacunas", "lacunasBiblioteca", "riscos", "foraDeFase"],
          properties: {
            kind: { const: "plano" },
            classificacaoSistema: { enum: ["100% crud", "misto", "predominantemente custom"] },
            requerAgenteDedicado: { type: "boolean" },
            requisitos: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "texto", "origem", "classificacao"],
                properties: {
                  id: { type: "string", pattern: "^REQ-[A-Z0-9_-]+$" },
                  texto: { type: "string", minLength: 1 },
                  origem: { type: "string", minLength: 1, description: "Seção/trecho da especificação de onde o requisito foi extraído" },
                  classificacao: { enum: ["crud", "custom", "lacuna"] },
                },
              },
            },
            especificacaoCrud: {
              type: "object",
              additionalProperties: false,
              required: ["entidades"],
              properties: {
                entidades: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["nome", "campos"],
                    properties: {
                      nome: { type: "string", minLength: 1 },
                      campos: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                      mascarasValidacoes: { type: "array", items: { type: "string" } },
                      menu: { type: "string" },
                    },
                  },
                },
                observacoes: { type: "string" },
              },
            },
            tarefas: { type: "array", minItems: 1, items: macroTask },
            matrizCobertura: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["req", "cobertoPor"],
                properties: {
                  req: { type: "string", minLength: 1 },
                  cobertoPor: { type: "string", minLength: 1, description: "tarefa:<seq> | crud:<entidade> | fora_de_fase" },
                  justificativa: { type: "string" },
                },
              },
            },
            lacunas: { type: "array", items: { type: "string" } },
            lacunasBiblioteca: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["funcionalidade"],
                properties: {
                  funcionalidade: { type: "string", minLength: 1 },
                  req: { type: "string", minLength: 1 },
                  contexto: { type: "string", description: "Por que a biblioteca não cobre nativamente" },
                },
              },
            },
            riscos: { type: "array", items: { type: "string" } },
            foraDeFase: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["req", "motivo"],
                properties: {
                  req: { type: "string", minLength: 1 },
                  motivo: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "resumo", "perguntas"],
          properties: {
            kind: { const: "perguntas" },
            resumo: { type: "string", minLength: 1 },
            perguntas: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
          },
        },
      ],
    },
    example: {
      kind: "plano",
      classificacaoSistema: "misto",
      requerAgenteDedicado: true,
      requisitos: [{ id: "REQ-F-001", texto: "Cadastro de colaboradores com CPF e acesso restrito.", origem: "Seção 3 — Requisitos funcionais", classificacao: "crud" }],
      especificacaoCrud: { entidades: [{ nome: "colaborador", campos: ["nome", "cpf", "email"], mascarasValidacoes: ["cpf"], menu: "Cadastros" }], observacoes: "Auth única da plataforma." },
      tarefas: [{ seq: 1, titulo: "Modelo de dados e tenancy", objetivo: "Definir entidades, tenancy e permissões.", escopo: "Entra: schema e config; não entra: telas custom.", aceite: ["Migration aplicada", "RBAC validado"], requisitos: ["REQ-F-001"], executor: "biblioteca-global", depende_de: [], auto_start: false, risco: "medio" }],
      matrizCobertura: [{ req: "REQ-F-001", cobertoPor: "tarefa:1", justificativa: "Modelo de dados cobre o cadastro." }],
      lacunas: [],
      lacunasBiblioteca: [{ funcionalidade: "Visão agrupada por área", req: "REQ-F-009", contexto: "CRUD genérico não agrupa registros por categoria na listagem." }],
      riscos: ["Especificação de integrações ainda incompleta."],
      foraDeFase: [{ req: "REQ-I-002", motivo: "Integração fiscal depende de contrato externo não disponível nesta fase." }],
    },
    instructions: 'Responda somente com um JSON único, sem texto ao redor. Forma "plano" (informação suficiente): {"kind":"plano","classificacaoSistema":"100% crud|misto|predominantemente custom","requerAgenteDedicado":true|false,"requisitos":[{"id":"REQ-F-001","texto":"...","origem":"seção/trecho da spec","classificacao":"crud|custom|lacuna"}],"especificacaoCrud":{"entidades":[{"nome":"...","campos":["..."],"mascarasValidacoes":["..."],"menu":"..."}],"observacoes":"..."},"tarefas":[{"seq":1,"titulo":"...","objetivo":"...","escopo":"...","aceite":["..."],"requisitos":["REQ-F-001"],"executor":"biblioteca-global|agente-projeto","depende_de":[],"auto_start":false,"risco":"baixo|medio|alto"}],"matrizCobertura":[{"req":"REQ-F-001","cobertoPor":"tarefa:1|crud:entidade|fora_de_fase","justificativa":"..."}],"lacunas":["..."],"lacunasBiblioteca":[{"funcionalidade":"...","req":"REQ-F-009","contexto":"por que a biblioteca não cobre"}],"riscos":["..."],"foraDeFase":[{"req":"...","motivo":"..."}]}. Forma "perguntas" (somente se faltar informação DECISÓRIA — não presuma): {"kind":"perguntas","resumo":"entendimento atual","perguntas":["..."]} com no máximo 8 perguntas numeradas. Regras: TODO requisito do inventário deve aparecer na matrizCobertura; depende_de expressa ordem topológica linear (apenas seq anteriores); se requerAgenteDedicado=false, nenhuma tarefa pode ter executor "agente-projeto"; alvo indicativo de 8 a 15 tarefas macro agrupadas por capacidade de sistema.',
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
