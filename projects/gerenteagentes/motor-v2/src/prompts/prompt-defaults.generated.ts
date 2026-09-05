/** Gerado por `npm run prompts:export-defaults`. Deve ser versionado no Git. */
export const BUNDLED_PROMPT_DEFAULTS: Readonly<Record<string, { text: string; contractKey?: string; contractInstructions?: string }>> = {
  "analista.primeira_rodada_tarefa": {
    "text": "Você é o analista. Planeje a tarefa **TITULOTAREFA**. Tipo: **TIPOTAREFA**. Descrição: **DESCRICAOTAREFA**. Responda somente com JSON no contrato do Motor, usando o mínimo de subtarefas executáveis.",
    "contractKey": "analista.plano_ou_perguntas",
    "contractInstructions": "Responda somente com JSON. Quando estiver claro, use {\"subtarefas\":[{\"seq\":1,\"titulo\":\"...\",\"scope\":\"...\",\"acceptance_criteria\":[\"...\"]}]}. Quando faltar decisão, use {\"kind\":\"perguntas\",\"resumo\":\"...\",\"perguntas\":[\"...\"]}."
  },
  "analista.retomada_apos_clarificacao": {
    "text": "Reanalise **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Histórico já respondido: **HISTORICOCLARIFICACAO**. Não repita perguntas respondidas; devolva perguntas novas ou o plano em JSON.",
    "contractKey": "analista.plano_ou_perguntas",
    "contractInstructions": "Responda somente com JSON. Quando estiver claro, use {\"subtarefas\":[{\"seq\":1,\"titulo\":\"...\",\"scope\":\"...\",\"acceptance_criteria\":[\"...\"]}]}. Quando faltar decisão, use {\"kind\":\"perguntas\",\"resumo\":\"...\",\"perguntas\":[\"...\"]}."
  },
  "analista.retry_resposta_invalida": {
    "text": "A resposta anterior falhou por **TIPOFALHAANALISTA**. Responda novamente apenas com JSON válido, curto e completo, sem texto ao redor."
  },
  "analista.revisao_premissa_incorreta": {
    "text": "Revise a subtarefa **TEXTOSUBTAREFAORIGINAL** da tarefa **TEXTOTAREFA** considerando a refutação **ERROREPORTADOPELOAGENTEDEV** e as evidências **EVIDENCIASREFUTACAO**."
  },
  "auditor.auditoria_premissa_incorreta": {
    "text": "Audite se a premissa foi refutada com evidência verificável. Tarefa: **TEXTOTAREFA**. Subtarefa: **TEXTOSUBTAREFAORIGINAL**. Alegação: **ERROREPORTADOPELOAGENTEDEV**. Evidências: **EVIDENCIASREFUTACAO**."
  },
  "biblioteca-global.setup_projeto": {
    "text": "Crie o projeto **NOMEPROJETO** (**SLUGPROJETO**) na plataforma. Descrição: **DESCRICAOPROJETO**. ID: **IDPROJETOPLATAFORMA**. Respeite as convenções e valide build e testes."
  },
  "dev.primeira_rodada_tarefa": {
    "text": "Você é o desenvolvedor. Execute a subtarefa **NUMSUBTAREFA** — **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Tipo: **TIPOTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Workspace: **WORKSPACE**. Não faça commit. Responda em JSON com status done, need_help, blocked_environment ou premise_incorrect.",
    "contractKey": "dev.resultado_execucao",
    "contractInstructions": "Responda somente com JSON: {\"status\":\"done|need_help|blocked_environment|premise_incorrect\",\"summary\":\"...\",\"reason\":\"...\"}. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision."
  },
  "dev.retorno_por_falha_de_gate": {
    "text": "Retome a subtarefa **TITULOSUBTAREFA** da tarefa **TITULOTAREFA** no workspace **WORKSPACE**. O gate anterior falhou: **ERROGATEANTERIOR**. Corrija a causa raiz, preserve o que já funciona, não faça commit e responda no contrato JSON do Motor.",
    "contractKey": "dev.resultado_execucao",
    "contractInstructions": "Responda somente com JSON: {\"status\":\"done|need_help|blocked_environment|premise_incorrect\",\"summary\":\"...\",\"reason\":\"...\"}. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision."
  },
  "monitor.classificacao_falha_de_gate": {
    "text": "Classifique a falha da tarefa **IDTAREFA**, subtarefa **IDSUBTAREFA**, ocorrência **OCORRENCIAGATE**. Tarefa: **TITULOTAREFA**. Executor: **AGENTEEXECUTOR**. Repo: **REPOSITORIO**. Subtarefa: **TITULOSUBTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Modelo: **MODELOEXECUTOR** (**INDICEESCADA**). Comando: **COMANDOFALHO**. Erro: **ERROTAREFAANTERIOR**. Responda somente no JSON de veredito esperado.",
    "contractKey": "monitor.veredito_gate",
    "contractInstructions": "Responda somente com JSON: {\"verdict\":\"agent_can_solve|code_files_issue|test_files_issue|motor_issue\",\"analysis\":\"...\",\"solution\":\"...\"}."
  },
  "monitor.correcao_motor": {
    "text": "Investigue a tarefa **IDTAREFA**, subtarefa **IDSUBTAREFA**. Motivo: **MOTIVOBLOQUEIO**. Comando: **COMANDO**. Evidência: **EVIDENCIA**. Proponha uma correção segura e verificável do Motor."
  }
}
