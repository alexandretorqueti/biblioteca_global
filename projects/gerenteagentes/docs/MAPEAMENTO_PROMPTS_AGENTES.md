# Mapeamento de prompts dos agentes

Este documento registra os pontos em que o GerenteAgentes compõe uma mensagem
de missão antes de chamar um agente. O catálogo executável correspondente está
em `motor-v2/src/prompts/prompt-catalog.ts`; ele será a fonte de identificação
da futura tabela editável de prompts.

## Situações mapeadas

| Chave | Tipo de agente | Situação | Chamador atual | Dados dinâmicos que precisam ser substituídos |
|---|---|---|---|---|
| `biblioteca-global.setup_projeto` | biblioteca-global | criação/setup de projeto | `api/gerenteagentes.service.ts#montarMissaoSetup` | nome, slug, descrição e ID do projeto na plataforma |
| `analista.primeira_rodada_tarefa` | analista | primeira análise da tarefa | `TaskWorker#buildAnalystPrompt` | título, descrição e tipo da tarefa |
| `analista.retomada_apos_clarificacao` | analista | nova análise após resposta de clarificação | `TaskWorker#buildAnalystPrompt` | título, descrição e histórico de perguntas/respostas |
| `analista.retry_resposta_invalida` | analista | retry após JSON truncado ou inválido | `TaskWorker#analystCorrectiveFeedback` | tipo da falha de parsing (`truncated`/`invalid`) |
| `dev.primeira_rodada_tarefa` | dev | primeira entrega da subtarefa (inclui automação/verificação) | `TaskWorker#buildProgrammerPrompt` | tarefa, subtarefa, escopo, critérios, tipo e workspace |
| `dev.retorno_por_falha_de_gate` | dev | rework após build/teste rejeitado ou escala de modelo | `TaskWorker#buildProgrammerPrompt` | contexto da subtarefa e erro/feedback do gate anterior |
| `monitor.classificacao_falha_de_gate` | monitor | classificação de causa raiz de falha de gate | `GateFailureClassifier#buildGateFailurePrompt` | tarefa, subtarefa, ocorrência, agente, repo, modelo, comando e erro |
| `monitor.correcao_motor` | monitor | missão de correção operacional do motor | `MotorMonitorStep#buildMission` | tarefa, subtarefa, motivo, comando e evidência |

## Marcadores canônicos

Os marcadores abaixo são nomes de contrato para a tabela. Eles devem ser
substituídos antes do envio ao runtime; não devem aparecer no prompt final.

| Marcador | Valor em runtime |
|---|---|
| `**TITULOTAREFA**` / `**DESCRICAOTAREFA**` / `**TIPOTAREFA**` | campos da tarefa pai |
| `**NUMSUBTAREFA**` / `**TITULOSUBTAREFA**` / `**ESCOPO**` / `**CRITERIOSACEITE**` | dados da subtarefa |
| `**WORKSPACE**` / `**REPOSITORIO**` | caminho do workspace/repositório |
| `**HISTORICOCLARIFICACAO**` | histórico formatado de clarificação |
| `**TIPOFALHAANALISTA**` | `truncated` ou `invalid` |
| `**ERROGATEANTERIOR**` / `**ERROTAREFAANTERIOR**` | saída do build/teste ou falha da rodada anterior |
| `**IDTAREFA**` / `**IDSUBTAREFA**` / `**OCORRENCIAGATE**` | identificadores e número da ocorrência |
| `**AGENTEEXECUTOR**` / `**MODELOEXECUTOR**` / `**INDICEESCADA**` | executor e posição do modelo |
| `**COMANDOFALHO**` / `**COMANDO**` / `**EVIDENCIA**` / `**MOTIVOBLOQUEIO**` | diagnóstico operacional do gate/monitor |
| `**NOMEPROJETO**` / `**SLUGPROJETO**` / `**DESCRICAOPROJETO**` / `**IDPROJETOPLATAFORMA**` | dados do setup do projeto |

## Observações de cobertura

- A criação de subtarefa de correção (`createCorrectionOnRepeatedGateFailure`)
  não compõe nem envia prompt próprio; a execução posterior passa pelo registro
  `dev.retorno_por_falha_de_gate`.
- A troca de modelo na escada não cria uma nova situação funcional: reutiliza o
  prompt da situação atual, mantendo os mesmos dados dinâmicos.
- O chat da Isa e o chat administrativo encaminham texto fornecido pelo usuário
  (`IsaChatBridgeService`); não há prompt fixo composto nesses chamadores e,
  portanto, eles não entram na tabela de prompts de missão.
- `getWelcomeMessage` é uma saudação estática e não chama agente; fica fora do
  catálogo.
- `MotorMonitorStep` é um fluxo exportado/legado de correção operacional,
  diferente da classificação de gate feita por `GateFailureClassifier`, por
  isso os dois registros de monitoramento são mantidos separadamente.

