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
  | "resolucao_bloqueio"
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
    prompt: "Você é o analista responsável por transformar a tarefa **TITULOTAREFA** em um plano completo, executável e verificável. Tipo: **TIPOTAREFA**. Leia integralmente a descrição abaixo, preserve todos os requisitos, etapas numeradas, sequência e definição de pronto. Não minimize artificialmente a quantidade de subtarefas nem una etapas independentes. Cada subtarefa deve ter uma responsabilidade principal, escopo detalhado, entregáveis concretos, critérios objetivos e requisitos cobertos. Identifique todos os requisitos como REQ-* e forneça a matriz de cobertura. Se a descrição estiver truncada, incompleta ou ambígua, não invente um plano: peça esclarecimentos. Descrição integral: **DESCRICAOTAREFA**\n\n**CONTRATOSAIDA**",
    contractKey: "analista.plano_ou_perguntas",
  },
  {
    key: "analista.retomada_apos_clarificacao",
    agentType: "analista",
    situation: "retomada_apos_clarificacao",
    source: "motor-v2/src/workers/TaskWorker.ts#buildAnalystPrompt",
    markers: ["**TITULOTAREFA**", "**DESCRICAOTAREFA**", "**HISTORICOCLARIFICACAO**"],
    prompt: "Reanalise **TITULOTAREFA** usando a descrição integral: **DESCRICAOTAREFA**. Histórico já respondido: **HISTORICOCLARIFICACAO**. Preserve todos os requisitos e etapas, não una responsabilidades independentes, e não repita perguntas respondidas. Quando estiver claro, devolva plano completo com requisitos e matriz de cobertura; caso contrário, faça perguntas objetivas.\n\n**CONTRATOSAIDA**",
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
    prompt: "Você é o desenvolvedor. Execute a subtarefa **NUMSUBTAREFA** — **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Tipo: **TIPOTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Workspace: **WORKSPACE**. Não faça commit. Para tarefas que exigem mudança ou importação de dados, crie a migration correta no diretório de migrations do projeto. Não abra conexão TCP/MySQL, não use host.docker.internal, não procure/peça credenciais e não execute SQL. Responda com status database_operation e script_path relativo da migration para revisão e aplicação no fluxo de deploy. Responda em JSON.\n\n**CONTRATOSAIDA**",
    contractKey: "dev.resultado_execucao",
  },
  {
    key: "dev.retorno_por_falha_de_gate",
    agentType: "dev",
    situation: "retorno_por_falha_de_gate",
    source: "motor-v2/src/workers/TaskWorker.ts#buildProgrammerPrompt",
    markers: ["**TITULOTAREFA**", "**TITULOSUBTAREFA**", "**ERROGATEANTERIOR**", "**WORKSPACE**"],
    prompt: "Retome a subtarefa **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Workspace: **WORKSPACE**. O gate anterior falhou: **ERROGATEANTERIOR**. Corrija a causa raiz, preserve o que já funciona, não faça commit e responda no contrato JSON do Motor.\n\n**CONTRATOSAIDA**",
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
    markers: ["**IDTAREFA**", "**IDSUBTAREFA**", "**WORKSPACE**", "**TENTATIVA**", "**MOTIVOBLOQUEIO**", "**COMANDO**", "**EVIDENCIA**"],
    prompt: `## Missão de Recuperação do Motor

Você é o agente responsável por diagnosticar e tentar resolver um bloqueio real do Motor-v2.

### Identificação

Tarefa: **IDTAREFA**
Subtarefa: **IDSUBTAREFA**
Workspace autorizado: **WORKSPACE**
Tentativa atual: **TENTATIVA**

### Bloqueio identificado

Motivo:
**MOTIVOBLOQUEIO**

Comando que falhou:
**COMANDO**

Evidência:
**EVIDENCIA**

### Objetivo

Investigue a causa do bloqueio no workspace autorizado e tente corrigir o problema para permitir a execução normal da subtarefa.

### Procedimento obrigatório

1. Inspecione o estado atual do workspace e os arquivos relacionados ao erro.
2. Confirme se o bloqueio é causado por código ou configuração do projeto; comando, teste ou dependência; estado inconsistente do Motor; ambiente local; ou recurso externo indisponível.
3. Se a causa puder ser corrigida dentro do escopo autorizado, implemente a correção mínima necessária.
4. Execute novamente o comando que falhou ou um teste equivalente que comprove a correção.
5. Verifique se a correção não introduziu falhas relacionadas.
6. Deixe as alterações salvas no workspace para que a subtarefa possa ser retomada.

### Restrições

- Trabalhe somente no workspace autorizado.
- Preserve o objetivo original da tarefa.
- Não faça push.
- Não altere a branch base.
- Não altere configurações globais do OpenClaw, Gateway, Docker ou infraestrutura compartilhada.
- Não contorne testes, gates ou validações.
- Não declare o bloqueio resolvido sem evidência de validação.
- Se depender de uma ação externa ou de infraestrutura fora do escopo, não invente uma correção: registre exatamente o que precisa ser feito.

### Resposta obrigatória

Responda neste formato:

STATUS: RESOLVIDO | PARCIALMENTE_RESOLVIDO | NAO_RESOLVIDO

CAUSA:
<causa técnica confirmada>

CORREÇÃO:
<alterações realizadas ou “nenhuma”>

VALIDAÇÃO:
<comandos executados e resultados>

RETOMADA:
<o que deve ser executado na próxima tentativa>

BLOQUEIO_REMANESCENTE:
<descreva o impedimento restante ou “nenhum”>`,
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
  {
    key: "monitor.resolucao_bloqueio",
    agentType: "monitor",
    situation: "resolucao_bloqueio",
    source: "motor-v3/src/monitor/MonitorResolutionConsumer.ts#buildMission",
    markers: [
      "**IDTAREFA**",
      "**TITULOTAREFA**",
      "**IDSUBTAREFA**",
      "**REPOSITORIO**",
      "**BRANCHBASE**",
      "**BRANCHDEV**",
      "**BRANCHINTEGRACAO**",
      "**WORKSPACE**",
      "**MOTIVOBLOQUEIO**",
      "**COMANDO**",
      "**EVIDENCIA**",
    ],
    prompt: `## Missão — Resolução de Bloqueio (Monitor)

Você é o resolvedor de problemas das tarefas.

### Identificação

Tarefa: **IDTAREFA** — **TITULOTAREFA**
Subtarefa: **IDSUBTAREFA**
Repositório: **REPOSITORIO**
Branch base: **BRANCHBASE**
Branch do dev: **BRANCHDEV**
Branch de integração: **BRANCHINTEGRACAO**
Workspace da tarefa: **WORKSPACE**

### Bloqueio identificado

Motivo:
**MOTIVOBLOQUEIO**

Comando que falhou:
**COMANDO**

Evidência:
**EVIDENCIA**

### Objetivo

Analise por que a tarefa foi bloqueada e, ao descobrir a causa, identifique a origem do problema e siga o fluxo correspondente. Você tem acesso total: pode olhar e mexer na branch do dev, na branch de integração e até na pasta base, se for necessário.

### Fluxo de resolução

1. Investigue a causa raiz do bloqueio: código, logs, testes, migrations, estado do motor e do banco.
2. Classifique a origem do problema e aja:

**A) Erro do dev (e ele pode resolver):** você resolve o código dele na branch do dev, roda os testes para validar, deixa a branch pronta e desbloqueia a tarefa para ela seguir seu curso.

**B) Testes do desenvolvedor não rodando:** corrija o que impede os testes de rodar (código ou testes), valide executando-os e desbloqueie a tarefa.

**C) Erro causado pelo motor:**
   a. Crie uma branch a partir da base;
   b. Resolva o problema do motor nessa branch;
   c. Crie os testes se necessário;
   d. Mergeie para a base;
   e. Devolva a branch para a base;
   f. Rode o script de deploy;
   g. Após a correção do motor, volte à tarefa que ficou travada, resolva o problema dela e desbloqueie. Se você achar melhor deixar o motor (com o novo código) resolver o problema da tarefa sozinho, apenas desbloqueie a tarefa e deixe seguir o curso.

### Regras

- Não contorne testes, gates ou validações para “passar”.
- Nunca declare resolução sem evidência de validação (comandos executados e resultados).
- Toda resolução deve gerar uma mensagem para o chat da tarefa explicando o que era o problema e como você resolveu.
- Se o problema depender de ação externa (infraestrutura, credenciais, aprovação humana), não invente correção: informe exatamente o que é necessário e mantenha o bloqueio.

### Resposta obrigatória

Responda neste formato:

STATUS: RESOLVIDO | PARCIALMENTE_RESOLVIDO | NAO_RESOLVIDO
ORIGEM: DEV | TESTES_DEV | MOTOR | EXTERNO

CAUSA:
<causa técnica confirmada>

CORREÇÃO:
<alterações realizadas, branches e commits afetados, ou “nenhuma”>

VALIDAÇÃO:
<comandos executados e resultados>

DEPLOY:
<script de deploy executado e resultado, ou “não se aplica”>

RETOMADA:
<o que a tarefa/o motor deve fazer em seguida>

MENSAGEM_CHAT:
<mensagem para o chat da tarefa explicando o que era o problema e como foi resolvido>`,
  },
]
