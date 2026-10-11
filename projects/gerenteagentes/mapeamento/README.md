# Mapeamento do código — GerenteAgentes

> Última inspeção: 2026-10-03. Este documento é um mapa de navegação, não substitui a leitura do código. Antes de alterar o sistema, confirme o estado atual do Git e procure implementações e testes relacionados.

## 1. Contexto e limites

O GerenteAgentes é um projeto da plataforma **Biblioteca Global**, localizado em `projects/gerenteagentes`. A Biblioteca Global é um monorepo TypeScript com:

- `apps/api`: API NestJS e infraestrutura compartilhada;
- `apps/web`: aplicação React/Vite;
- `packages/shared`: contratos compartilhados;
- `packages/api-client`: acesso HTTP do frontend;
- `packages/ui`: componentes visuais e o gerador de sistemas;
- `projects/gerenteagentes`: schema, configuração, telas, API específica e motores de orquestração.

O projeto usa MySQL/Drizzle. O schema do projeto fica em `schema.ts`; migrations ficam em `migrations/`. A UI é declarada em `config.ts` e complementada pelas telas React de `screens/`. A API específica é registrada pelo `GerenteAgentesModule` em `api/`.

Não tratar como código-fonte canônico:

- `dist/`: saída compilada;
- `node_modules/`: dependências;
- `worktrees/`: cópias temporárias de execuções do motor;
- `motor-v3.log`: log operacional;
- `motor-v2/`: implementação anterior, mantida como referência/compatibilidade. O runtime em evolução é o `motor-v3/`.

## 2. Estrutura de alto nível

```text
projects/gerenteagentes/
├── schema.ts                 # entidades Drizzle do projeto (fonte da verdade)
├── config.ts                 # menus, cadastros, campos, ações e rotas da UI gerada
├── migrations/               # evolução SQL versionada
├── api/                      # controllers/services NestJS e integração com OpenClaw
├── screens/                  # telas React específicas e registry de componentId
├── src/                      # entrada do pacote e utilitários compartilhados
├── motor-v3/                 # motor event-driven atual
│   ├── src/start.ts          # composition root e servidor HTTP do motor
│   ├── src/db/               # schema operacional, bootstrap, seeds e triggers
│   ├── src/queue/            # RabbitMQ, outbox, consumo idempotente e DLQ
│   ├── src/coordinator/      # análise, claims, cancelamento e recuperação
│   ├── src/execution/        # worktrees, agentes dev, verificação e integração Git
│   ├── src/testing/          # baseline, gates e recuperação de testes
│   ├── src/deploy/           # fila e deploy blue-green remoto
│   ├── src/monitor/          # bloqueios e resolução pelo Monitor/humano
│   ├── src/catalog/          # catálogo configurável de eventos/reações
│   ├── src/classifier/       # classificação de falhas/eventos
│   ├── src/executor/         # execução de ações compostas por primitivas
│   └── test/                 # testes unitários e de integração do motor
└── motor-v2/                 # motor anterior; consultar para histórico e contratos herdados
```

## 3. Fluxo principal do sistema

1. A UI cria ou acompanha uma tarefa pelas telas e endpoints do GerenteAgentes.
2. A API persiste tarefas, subtarefas, chats, bloqueios e eventos no database do projeto.
3. O motor-v3 publica/consome mensagens duráveis por outbox + RabbitMQ.
4. `TaskCoordinator` reserva a análise; `ConsoleAnalystRunner` conversa com o agente analista e persiste o plano/subtarefas.
5. `SubtaskExecutionConsumer` e `DevelopmentExecutionConsumer` preparam um worktree e lançam o agente desenvolvedor.
6. A entrega passa por verificação Git, comandos de build/teste e gate diferencial.
7. O `Bookkeeper`/integrador faz commit, merge e promoção; o deploy entra na fila própria.
8. Falhas previstas são classificadas pelo catálogo. Bloqueios e casos não resolvidos seguem para os componentes de Monitor.
9. O `Scheduler` e os reconciliadores recuperam claims, sessões, jobs e execuções órfãs.

## 4. Dados e propriedades importantes

### 4.1 Entidades do schema principal (`schema.ts`)

| Grupo | Tabelas/exportações | Finalidade e propriedades centrais |
|---|---|---|
| Cadastro | `contatos`, `agentes`, `projetosCaptados`, `definicoes` | Contatos, agentes OpenClaw, projetos e requisitos captados. Projetos ligam slug, agente, repositório/configuração e estado ativo. |
| Configuração | `projetoMotorConfig`, `motorConfiguracoes`, `globalModelSelection`, `projectModelSelection` | Comandos de build/teste/deploy, limites, seleção global e por projeto de modelos. |
| Trabalho | `tarefas`, `subtarefas`, `bloqueios`, `tarefaEventos` | Hierarquia tarefa/subtarefa, dependência (`dependsOnTaskId`), estados derivados, tentativas, bloqueios e trilha de eventos. |
| Runtime | `taskRuntimeFacts`, `motorActiveExecutions`, `executionResources`, `executionResourceQueue` | Fatos observados, execuções ativas, leases e espera por capacidade. |
| Mensageria | `motorOutbox`, `motorMessageProcessingState` | Publicação durável e idempotência do consumo. |
| Sessões | `motorAgentSessions`, `motorAgentSessionMessages`, `motorAgentSessionFailures`, `analystTaskSessions`, `analystTaskSessionMessages` | Continuidade, auditoria e diagnóstico das conversas dos agentes. |
| Entregas | `subtarefasEntregas`, `deployRequests`, `promotionConflictAnalyses` | Artefatos da execução, fila de deploy e análise de conflitos de promoção. |
| Prompts | `promptsAgentes`, `promptsMascaras`, `promptsContratos`, `promptsContratosVersoes`, `promptsVersoes`, `promptsExecucoes` | Prompts gerenciados, contratos versionados e histórico de composição/execução. |
| Conversas | `chats`, `chatMensagens`, `tarefaChats`, `tarefaChatEntregas`, `projetoChats`, `tarefaContextosExecucao` | Conversas gerais, por tarefa/projeto e checkpoints entregues ao runtime. |

`annotations` contém metadados de formulário (rótulos, tipos, obrigatoriedade, largura etc.) usados pela Biblioteca Global. Alterações em `schema.ts` exigem geração e revisão das migrations.

### 4.2 Schema operacional do motor-v3 (`motor-v3/src/db/schema.ts`)

- `motorEvents`, `motorPatterns`, `motorPrimitives`, `motorActions`, `motorReactions`: catálogo configurável de classificação e reação.
- `motorOccurrences`: contagem contextual por tarefa/subtarefa/geração.
- `motorPromotionState`: estado e compensação de promoção Git.
- `motorCatalogProposals`: propostas do Monitor para ampliar o catálogo.
- `motorEventLog`: auditoria de mensagens/eventos/ações.
- `motorModelCooldown`: indisponibilidade temporária de modelos.
- `analystTaskSessions` e `analystTaskSessionMessages`: auditoria da análise.

## 5. API e integração com a Biblioteca Global

### Classes principais

- `GerenteAgentesModule`: módulo NestJS; registra controllers/services e inicia o polling de status.
- `GerenteAgentesController`: rotas específicas para tarefas, agentes, modelos, prompts, monitoramento, Git e controles operacionais.
- `GerenteAgentesService`: fachada de regras e consultas do projeto; concentra grande parte da integração entre banco, tarefas e motor.
- `TaskStatusPollerService`: atualiza/deriva estado operacional periodicamente e publica mudanças relevantes.
- `GitInspectorService`: lê commits, árvores, diffs e simula conflitos/merges para a UI.
- `OperationalFeedService`: agrega mensagens, eventos e ações pendentes em um feed limitado e ordenado.
- `IsaChatController`, `IsaChatService`, `IsaChatBridgeService`: onboarding/conversa da Isa e ponte para sessões OpenClaw.

### Funções e tipos úteis

- `aggregateOperationalFeed(...)`: combina as fontes do feed operacional.
- `configuracaoPorChave(...)`: resolve uma definição do catálogo `MOTOR_CONFIGURACOES`.
- `getWelcomeMessage`, `describeOnboardingState`, `isValidEmail`, `isValidBrPhone`: regras do fluxo Isa.
- `GitCommit`, `GitTreeEntry`, `GitDiffFile`, `MergeSimulationResult`: contratos da inspeção Git.

## 6. UI e telas

`config.ts` declara menus, resources, campos, child routes e row actions do sistema gerado. `screens/registry.ts` liga cada `componentId` a uma tela React.

| Tela/componente | Responsabilidade |
|---|---|
| `DashboardScreen` | Resumo operacional e indicadores. |
| `TaskMonitorScreen` | Acompanhamento detalhado da tarefa, ações e atualizações ao vivo. |
| `OperationMapScreen` / `OperationMapCanvas` / `TaskFlowMap` | Mapa do fluxo, estações, prioridades e atividades de agentes. |
| `NovaTarefaScreen` / `TarefaForm` | Criação de tarefa e dependência entre tarefas. |
| `ModelSelectionScreen` | Ordenação/seleção de modelos por papel/projeto. |
| `PromptsScreen` | Administração de prompts e contratos. |
| `ConfiguracoesScreen` | Configurações operacionais do motor. |
| `MotorV3TablesScreen` | Visualização administrativa de tabelas do motor-v3. |
| `TestHistoryScreen` | Histórico e resultado dos gates de teste. |
| `IsaChatScreen` | Interface de conversa com a Isa. |
| `DiffViewer`, `ConflictViewer`, `TaskCodeViewer` | Inspeção de alterações, conflitos e código de worktrees/commits. |
| `AgentStatusStrip`, `OperationalFeedPanel` | Saúde/atividade dos agentes e feed operacional. |

Funções auxiliares importantes: `getEffectiveStatus`, `getEffectiveStatusForMetrics`, `deriveTaskPriority`, `calcularMetricas`, `feedItemFromEnvelope`, `mergeFeedItem` e `normalizeFeedSnapshot`.

## 7. Motor-v3: classes e responsabilidades

### Barramento, catálogo e ações

- `MessageBus`: `send`, `on`, `off` e middlewares; distribui mensagens internas por tipo.
- `EventLogger`: middleware de auditoria estruturada.
- `CatalogLoader`: carrega e mantém o catálogo em memória.
- `EventClassifier`: compara entradas com patterns e resolve evento/ocorrência/reação.
- `ActionExecutor`: registra handlers de primitivas e executa ações compostas.
- `MotorContext`: reúne tarefa, subtarefa, execução, sessão, modelo, geração, banco e flags de controle.

### Filas e idempotência

- `RabbitMqTransport` e `InMemoryQueueTransport`: implementações de `QueueTransport`.
- `OutboxPublisher`: publica registros pendentes da outbox.
- `QueueConsumer`: consome, confirma, repete e encaminha falhas terminais.
- `MessageProcessingState`: claim/idempotência por mensagem.
- `TerminalFailureRouter`: roteia falha terminal conforme o tipo da mensagem.
- `MotorActivityGate`: informa se o motor está aceitando/processando trabalho.
- `createQueueMessage(...)`: cria envelope com id, correlation/causation e payload.

### Análise e coordenação

- `TaskCoordinator`: seleciona a próxima tarefa, cria claim e executa análise.
- `MySqlTaskCoordinatorRepository`: persistência de reservas, planos e estados.
- `ConsoleAnalystRunner`: cria/retoma sessão, envia contexto/prompt e interpreta a resposta.
- `ConsoleHttpApi`: cliente HTTP para o Console OpenClaw.
- `ManagedAnalysisPromptResolver` e `ManagedDevelopmentPromptResolver`: resolvem prompts versionados.
- `ContractArtifactStore`: persiste o contrato/artefato produzido pela análise.
- `AnalysisClaimReconciler` e `AnalysisSessionRecoveryReconciler`: recuperam claims e sessões órfãs.
- `AnalysisFailureBlocker`: registra bloqueio quando a análise não pode continuar.
- `SanitizeSessionService`: arquiva/reinicia sessão inválida.
- `TaskCancelConsumer`: aplica cancelamento governado.
- `TaskEventRecorder`: registra transições e fatos da tarefa.
- Funções `parseAnalystReply`, `sanitizeModelResponse` e utilitários de `PromptChunking`: validam e fragmentam contexto/resposta.

### Desenvolvimento, Git e reconciliação

- `GitWorktreePreparer`: cria/prepara worktree isolado; `mapHostRepoPathToContainer` traduz paths conhecidos.
- `WorkerLauncher`: escolhe/aciona modelo, mantém a conversa e retorna `WorkerResult`.
- `WorkerConsoleAdapter`: adapta o Console à interface usada pelo launcher.
- `SubtaskExecutionConsumer`: reserva subtarefa e inicia a execução.
- `DevelopmentExecutionConsumer`: conduz a fase de desenvolvimento.
- `SubtaskVerificationConsumer`: dispara e registra verificação da entrega.
- `GitVerificationIntegrator`: verifica escopo/diff e integra resultado Git.
- `MySqlDevelopmentExecutionRepository`: persistência da execução, capacidade, tentativas e entregas.
- `TaskExecutionReconciler`: deriva conclusão/continuidade olhando todas as subtarefas.
- `DevelopmentSessionRecoveryReconciler`: recupera sessões dev órfãs.
- `Bookkeeper`: operações Git de commit/merge/publish/promoção sob controle do motor.

### Testes

- `TestGateService`: executa baseline/pós-dev/retrabalho/pré-deploy e classifica regressões.
- `TestGateConsumer` e `TestGateOrchestrator`: consumo e coordenação do gate.
- `TestGateJobReconciler`: recupera jobs de teste abandonados.
- `TestRecoveryConsumer`: tenta corrigir falhas elegíveis.
- `BaselinePreflightRecovery`: prepara/repara baseline antes do desenvolvimento.
- `WorkspaceEnvironmentPreparer`: instala/prepara dependências e ambiente do worktree.

### Monitor e bloqueios

- `MonitorBlockerReconciler`: procura bloqueios ativos que precisam de análise.
- `MonitorResolutionConsumer`: executa e persiste a tentativa de resolução.
- `MonitorPromptResolver`: monta o prompt `monitor.resolucao_bloqueio`.
- `parseMonitorVerdict(...)`: interpreta `RESOLVIDO`, `PARCIALMENTE_RESOLVIDO` ou `NAO_RESOLVIDO` e a origem da falha.
- `ExternalResolutionHandler`: registra resolução feita fora do motor.
- `TaskUnblockedConsumer`: retoma processamento após desbloqueio.
- `ConsoleHumanNotifier`: entrega ao humano situações que exigem intervenção.
- `MonitorBridge`: ponte do catálogo/eventos inesperados para o Monitor.

### Deploy

- `DeployRepository`: claim, lote, membros e estado da fila de deploy.
- `DeployConsumer`: coordena deploy atômico e atualiza tarefas/lotes.
- `RemoteBlueGreenDeployer`: inicia e acompanha o script blue-green no host.
- `DeployDiagnostics`: coleta a situação corrente do deploy.
- `ApplyProjectMigrationsCli` e `PreDeployCli`: comandos auxiliares do pipeline.

### Estado e tempo

- `Scheduler`: emite ticks/timeouts e mantém a lista de execuções ativas.
- `DerivedTaskStatusResolver`: calcula o estado público a partir dos fatos, sem depender de uma coluna mutável de status da tarefa.
- `WorkerActivityService`: descreve atividade de analista/desenvolvedor/gerente para API/UI.

## 8. Primitivas registradas

As primitivas são handlers fixos usados pelas ações configuráveis:

- Git/workspace: `createWorktree`, `removeWorktree`, `installDependencies`, `verifyGit`, `runBuild`, `commitChanges`, `mergeBranch`, `revertMerge`, `publishBranch`, `promoteToBase`, `checkPaths`.
- Banco/estado: `persistPlan`, `createSubtasks`, `checkCommits`, `blockTask`, `blockSubtask`, `persistBlocker`, `unblockSubtask`.
- Sessão: `createSession`, `archiveSession`, `incrementGeneration`, `sendMessage`, `sendFeedback`, `waitForCompletion`, `parseReply`.
- Modelo: `cooldownModel`, `escalateModel`.
- Fila: `pauseAgentQueue`, `resumeAgentQueue`, `enqueueDeploy`.
- Controle: `setFlag`, `log`.

`ALL_PRIMITIVES`, `getPrimitiveByCode(...)` e `registerAllPrimitives(...)` formam o registry. Uma primitiva nova requer código, testes e redeploy; eventos/reactions existentes podem ser configurados no banco.

## 9. Pontos de entrada e comandos

- Motor-v3: `motor-v3/src/start.ts`; build gera `dist/start.js`.
- Scripts principais do motor: `build`, `start`, `test`, `typecheck`, `lint`, `db:generate`, `db:migrate`, `db:bootstrap-runtime` e `db:seed`.
- API/UI do GerenteAgentes são carregadas pelos registries da Biblioteca Global, não por um `main` próprio do projeto.
- Migrações do projeto: rode o script Drizzle previsto pelo monorepo após mudar `schema.ts`; nunca edite `_journal.json` manualmente.

## 10. Onde procurar por tipo de mudança

| Necessidade | Primeiro local a consultar |
|---|---|
| Campo/tabela nova | `schema.ts`, migrations e `annotations` |
| Menu/cadastro/ação visual | `config.ts` |
| Tela customizada | `screens/` e `screens/registry.ts` |
| Endpoint/regra da aplicação | `api/gerenteagentes.controller.ts` e `api/gerenteagentes.service.ts` |
| Estado exibido da tarefa | `motor-v3/src/status/DerivedTaskStatus.ts` e helpers das telas |
| Tarefa não inicia/análise travada | `coordinator/`, `analysis/`, outbox/RabbitMQ e reconciliadores |
| Subtarefa travada | `execution/`, sessões, leases, worktree e `TaskExecutionReconciler` |
| Build/teste inconsistente | `testing/` e configuração de comandos do projeto |
| Bloqueio/recuperação | `monitor/`, `classifier/`, `executor/` e catálogo no banco |
| Deploy | `deploy/`, `deployRequests` e documentação de deploy atômico |
| Falha de modelo | model selection, `motorModelCooldown` e resolvers de prompt/modelo |

## 11. Documentos essenciais antes de mexer no motor

- `README.md` e `MANUAL_DESENVOLVIMENTO.md` na raiz do monorepo;
- `projects/gerenteagentes/README.md`;
- `projects/gerenteagentes/motor-v3/README.md`;
- `projects/gerenteagentes/motor-v3/docs/ESPECIFICACAO.md`;
- `projects/gerenteagentes/motor-v3/docs/DEPLOY-ATOMICO.md`;
- `projects/gerenteagentes/motor-v3/docs/FILA-RABBITMQ.md`;
- `projects/gerenteagentes/motor-v3/docs/GOVERNANCA-COMANDOS-E-OBSERVABILIDADE.md`;
- documentos específicos em `projects/gerenteagentes/docs/` para status, prompts, concorrência, promoção, recuperação e acompanhamento.

## 12. Como manter este mapa útil

Atualize este documento quando surgir/remover um módulo, fluxo, tela, entidade ou ponto de entrada relevante. Não copie todos os métodos privados: registre responsabilidade, contratos públicos, propriedades persistidas e relações entre componentes. Sempre confira o código porque documentação e runtime podem divergir.
