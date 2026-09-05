/**
 * Catálogo funcional dos prompts usados pelo motor.
 *
 * Este catálogo é o contrato da futura tabela `prompts_agentes`: ele registra
 * quais situações precisam de um prompt e quais valores o motor deverá
 * substituir em tempo de execução. O campo `source` aponta o compositor atual
 * enquanto a migração para prompts persistidos não for concluída.
 */

export type PromptAgentType = "analista" | "dev" | "monitor" | "biblioteca-global"

export type PromptSituation =
  | "setup_projeto"
  | "primeira_rodada_tarefa"
  | "retomada_apos_clarificacao"
  | "retry_resposta_invalida"
  | "retorno_por_falha_de_gate"
  | "classificacao_falha_de_gate"
  | "correcao_motor"
  | "revisao_premissa_incorreta"
  | "auditoria_premissa_incorreta"

export interface AgentPromptCatalogEntry {
  key: string
  agentType: PromptAgentType
  situation: PromptSituation
  /** Arquivo e função onde o prompt ainda é composto no código. */
  source: string
  /** Marcadores que a implementação persistida deverá aceitar. */
  markers: readonly string[]
  /** Preenchido pela etapa posterior de migração; não é validado neste catálogo. */
  prompt: string
  contractKey?: string
}

export const AGENT_PROMPT_CATALOG: readonly AgentPromptCatalogEntry[] = [
  {
    key: "biblioteca-global.setup_projeto",
    agentType: "biblioteca-global",
    situation: "setup_projeto",
    source: "api/gerenteagentes.service.ts#montarMissaoSetup",
    markers: ["**NOMEPROJETO**", "**SLUGPROJETO**", "**DESCRICAOPROJETO**", "**IDPROJETOPLATAFORMA**"],
    prompt: "Crie o projeto **NOMEPROJETO** (**SLUGPROJETO**) na plataforma. Descrição: **DESCRICAOPROJETO**. ID: **IDPROJETOPLATAFORMA**. Respeite as convenções e valide build e testes.",
  },
  {
    key: "analista.primeira_rodada_tarefa",
    agentType: "analista",
    situation: "primeira_rodada_tarefa",
    source: "motor-v2/src/workers/TaskWorker.ts#buildAnalystPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**TIPOTAREFA**"],
    prompt: "Você é o analista. Planeje a tarefa **TITULOTAREFA**. Tipo: **TIPOTAREFA**. Descrição: **DESCRICAOTAREFA**. Use o mínimo de subtarefas executáveis.\n\n**CONTRATOSAIDA**",
    contractKey: "analista.plano_ou_perguntas",
  },
  {
    key: "analista.retomada_apos_clarificacao",
    agentType: "analista",
    situation: "retomada_apos_clarificacao",
    source: "motor-v2/src/workers/TaskWorker.ts#buildAnalystPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**HISTORICOCLARIFICACAO**"],
    prompt: "Reanalise **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Histórico já respondido: **HISTORICOCLARIFICACAO**. Não repita perguntas respondidas.\n\n**CONTRATOSAIDA**",
    contractKey: "analista.plano_ou_perguntas",
  },
  {
    key: "analista.retry_resposta_invalida",
    agentType: "analista",
    situation: "retry_resposta_invalida",
    source: "motor-v2/src/workers/TaskWorker.ts#analystCorrectiveFeedback",
    markers: ["**TIPOFALHAANALISTA**"],
    prompt: "A resposta anterior falhou por **TIPOFALHAANALISTA**. Responda novamente apenas com JSON válido, curto e completo, sem texto ao redor.",
  },
  {
    key: "dev.primeira_rodada_tarefa",
    agentType: "dev",
    situation: "primeira_rodada_tarefa",
    source: "motor-v2/src/workers/TaskWorker.ts#buildProgrammerPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**TIPOTAREFA**", "**NUMSUBTAREFA**", "**TITULOSUBTAREFA**", "**ESCOPO**", "**CRITERIOSACEITE**", "**WORKSPACE**"],
    prompt: "Você é o desenvolvedor. Execute a subtarefa **NUMSUBTAREFA** — **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Tipo: **TIPOTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Workspace: **WORKSPACE**. Não faça commit. Responda em JSON com status done, need_help, blocked_environment ou premise_incorrect.",
    contractKey: "dev.resultado_execucao",
  },
  {
    key: "dev.retorno_por_falha_de_gate",
    agentType: "dev",
    situation: "retorno_por_falha_de_gate",
    source: "motor-v2/src/workers/TaskWorker.ts#buildProgrammerPrompt",
    markers: ["**TITULOTAREFA**", "**TITULOSUBTAREFA**", "**ERROGATEANTERIOR**", "**WORKSPACE**"],
    prompt: "Retome a subtarefa **TITULOSUBTAREFA** da tarefa **TITULOTAREFA** no workspace **WORKSPACE**. O gate anterior falhou: **ERROGATEANTERIOR**. Corrija a causa raiz, preserve o que já funciona, não faça commit e responda no contrato JSON do Motor.",
    contractKey: "dev.resultado_execucao",
  },
  {
    key: "monitor.classificacao_falha_de_gate",
    agentType: "monitor",
    situation: "classificacao_falha_de_gate",
    source: "motor-v2/src/policies/GateFailureClassifier.ts#buildGateFailurePrompt",
    markers: ["**IDTAREFA**", "**IDSUBTAREFA**", "**OCORRENCIAGATE**", "**TITULOTAREFA**", "**AGENTEEXECUTOR**", "**REPOSITORIO**", "**TITULOSUBTAREFA**", "**ESCOPO**", "**CRITERIOSACEITE**", "**MODELOEXECUTOR**", "**INDICEESCADA**", "**COMANDOFALHO**", "**ERROTAREFAANTERIOR**"],
    prompt: "Classifique a falha da tarefa **IDTAREFA**, subtarefa **IDSUBTAREFA**, ocorrência **OCORRENCIAGATE**. Tarefa: **TITULOTAREFA**. Executor: **AGENTEEXECUTOR**. Repo: **REPOSITORIO**. Subtarefa: **TITULOSUBTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Modelo: **MODELOEXECUTOR** (**INDICEESCADA**). Comando: **COMANDOFALHO**. Erro: **ERROTAREFAANTERIOR**. Responda somente no JSON de veredito esperado.",
    contractKey: "monitor.veredito_gate",
  },
  {
    key: "monitor.correcao_motor",
    agentType: "monitor",
    situation: "correcao_motor",
    source: "motor-v2/src/steps/MotorMonitorStep.ts#buildMission",
    markers: ["**IDTAREFA**", "**IDSUBTAREFA**", "**MOTIVOBLOQUEIO**", "**COMANDO**", "**EVIDENCIA**"],
    prompt: "Investigue a tarefa **IDTAREFA**, subtarefa **IDSUBTAREFA**. Motivo: **MOTIVOBLOQUEIO**. Comando: **COMANDO**. Evidência: **EVIDENCIA**. Proponha uma correção segura e verificável do Motor.",
  },
  {
    key: "analista.revisao_premissa_incorreta",
    agentType: "analista",
    situation: "revisao_premissa_incorreta",
    source: "motor-v2/src/workers/TaskWorker.ts#replaceRefutedSubtask",
    markers: ["**TEXTOTAREFA**", "**TEXTOSUBTAREFAORIGINAL**", "**ERROREPORTADOPELOAGENTEDEV**", "**EVIDENCIASREFUTACAO**"],
    prompt: "Revise a subtarefa **TEXTOSUBTAREFAORIGINAL** da tarefa **TEXTOTAREFA** considerando a refutação **ERROREPORTADOPELOAGENTEDEV** e as evidências **EVIDENCIASREFUTACAO**.",
  },
  {
    key: "auditor.auditoria_premissa_incorreta",
    agentType: "monitor",
    situation: "auditoria_premissa_incorreta",
    source: "motor-v2/src/policies/PremiseRefutationPolicy.ts#validatePremiseRefutation",
    markers: ["**TEXTOTAREFA**", "**TEXTOSUBTAREFAORIGINAL**", "**ERROREPORTADOPELOAGENTEDEV**", "**EVIDENCIASREFUTACAO**"],
    prompt: "Audite se a premissa foi refutada com evidência verificável. Tarefa: **TEXTOTAREFA**. Subtarefa: **TEXTOSUBTAREFAORIGINAL**. Alegação: **ERROREPORTADOPELOAGENTEDEV**. Evidências: **EVIDENCIASREFUTACAO**.",
  },
]
