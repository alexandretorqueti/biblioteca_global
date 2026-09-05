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
}

export const AGENT_PROMPT_CATALOG: readonly AgentPromptCatalogEntry[] = [
  {
    key: "biblioteca-global.setup_projeto",
    agentType: "biblioteca-global",
    situation: "setup_projeto",
    source: "api/gerenteagentes.service.ts#montarMissaoSetup",
    markers: ["**NOMEPROJETO**", "**SLUGPROJETO**", "**DESCRICAOPROJETO**", "**IDPROJETOPLATAFORMA**"],
    prompt: "",
  },
  {
    key: "analista.primeira_rodada_tarefa",
    agentType: "analista",
    situation: "primeira_rodada_tarefa",
    source: "motor-v2/src/workers/TaskWorker.ts#buildAnalystPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**TIPOTAREFA**"],
    prompt: "",
  },
  {
    key: "analista.retomada_apos_clarificacao",
    agentType: "analista",
    situation: "retomada_apos_clarificacao",
    source: "motor-v2/src/workers/TaskWorker.ts#buildAnalystPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**HISTORICOCLARIFICACAO**"],
    prompt: "",
  },
  {
    key: "analista.retry_resposta_invalida",
    agentType: "analista",
    situation: "retry_resposta_invalida",
    source: "motor-v2/src/workers/TaskWorker.ts#analystCorrectiveFeedback",
    markers: ["**TIPOFALHAANALISTA**"],
    prompt: "",
  },
  {
    key: "dev.primeira_rodada_tarefa",
    agentType: "dev",
    situation: "primeira_rodada_tarefa",
    source: "motor-v2/src/workers/TaskWorker.ts#buildProgrammerPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**TIPOTAREFA**", "**NUMSUBTAREFA**", "**TITULOSUBTAREFA**", "**ESCOPO**", "**CRITERIOSACEITE**", "**WORKSPACE**"],
    prompt: "",
  },
  {
    key: "dev.retorno_por_falha_de_gate",
    agentType: "dev",
    situation: "retorno_por_falha_de_gate",
    source: "motor-v2/src/workers/TaskWorker.ts#buildProgrammerPrompt",
    markers: ["**TITULOTAREFA**", "**TITULOSUBTAREFA**", "**ERROGATEANTERIOR**", "**WORKSPACE**"],
    prompt: "",
  },
  {
    key: "monitor.classificacao_falha_de_gate",
    agentType: "monitor",
    situation: "classificacao_falha_de_gate",
    source: "motor-v2/src/policies/GateFailureClassifier.ts#buildGateFailurePrompt",
    markers: ["**IDTAREFA**", "**IDSUBTAREFA**", "**OCORRENCIAGATE**", "**TITULOTAREFA**", "**AGENTEEXECUTOR**", "**REPOSITORIO**", "**TITULOSUBTAREFA**", "**ESCOPO**", "**CRITERIOSACEITE**", "**MODELOEXECUTOR**", "**INDICEESCADA**", "**COMANDOFALHO**", "**ERROTAREFAANTERIOR**"],
    prompt: "",
  },
  {
    key: "monitor.correcao_motor",
    agentType: "monitor",
    situation: "correcao_motor",
    source: "motor-v2/src/steps/MotorMonitorStep.ts#buildMission",
    markers: ["**IDTAREFA**", "**IDSUBTAREFA**", "**MOTIVOBLOQUEIO**", "**COMANDO**", "**EVIDENCIA**"],
    prompt: "",
  },
]

