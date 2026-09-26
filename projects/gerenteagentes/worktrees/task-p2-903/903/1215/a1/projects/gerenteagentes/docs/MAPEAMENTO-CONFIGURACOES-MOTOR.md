# Mapeamento de configurações do Motor v2

Varredura realizada em `motor-v2/src`, `motor-v2/package.json`, `motor-v2/README.md` e migrations do projeto. O valor indicado é o default/fallback efetivo quando não existe valor específico da tarefa ou do projeto.

## Parâmetros operacionais candidatos à tela CONFIGURAÇÕES

| Nome estável sugerido | Valor atual | Origem | Consumidor(es) | Impacto |
|---|---:|---|---|---|
| `motor.max_workers` | `1` | `MOTOR_MAX_WORKERS` em `src/start.ts`; fallback de `MotorConfig`/`TaskCoordinator` | `TaskCoordinator.pump`, `activeDevelopmentCount` | Limita o total de subtarefas de desenvolvimento simultâneas; é o limite global de tarefas em paralelo identificado no motor. |
| `motor.max_workers_per_project` | `1` | `MotorConfig`, default de `TaskCoordinatorConfig` (`src/Motor.ts`, `src/coordinator/TaskCoordinator.ts`) | `canStartExecution(projectSlug)` | Limita concorrência por projeto; evita que um único projeto ocupe todo o motor. Hoje não há variável de ambiente no `start.ts`. |
| `motor.pump_interval_ms` | `30000` | literal em `src/Motor.ts` | `setInterval` que chama `coordinator.pump()` | Latência para detectar novas tarefas e retomar fila; valores baixos aumentam consultas/carga. |
| `motor.reconciler_interval_ms` | `30000` | argumento fixo em `src/start.ts` e fallback de `ExpirationReconciler` | `ExpirationReconciler.start()` | Frequência de limpeza de leases expirados, órfãos e inconsistências. |
| `motor.reconciler_max_staleness_ms` | `120000` | fallback em `src/reconciler/ExpirationReconciler.ts` | campo `maxStalenessMs` (atualmente armazenado, sem uso efetivo no fluxo) | Deve ser exposto somente após ligar o campo ao critério de reconciliação; hoje é configuração inerte. |
| `motor.api_port` | `3010` | `MOTOR_API_PORT` em `src/start.ts` | `MotorAPI` | Porta HTTP local do motor. É operacional, mas normalmente pertence ao ambiente/deploy, não à edição de usuários. |
| `motor.worker_timeout_ms` | não definido; usa `hard_timeout_ms` da tarefa ou `14400000` (4 h) | `TaskCoordinatorConfig.workerTimeoutMs`; `src/coordinator/TaskCoordinator.ts` | `armWorkerTimeout` | Teto de execução de worker. Deve permanecer separado do timeout da sessão do agente. |
| `motor.worker_silence_timeout_ms` | `600000` (10 min) | literal em `TaskCoordinator.armWorkerSilenceTimeout` | watchdog de silêncio do worker | Marca/encerra execução sem heartbeat; controla recuperação de workers travados. |
| `motor.resource_lease_ms` | `600000` (10 min) | literal no construtor de `Motor` (`ResourceLeaseService`) | `ResourceLeaseService.acquire/renew` | Duração do lock de recurso; muito baixo causa perda prematura, muito alto retarda recuperação. |
| `motor.resource_heartbeat_interval_ms` | `30000` (30 s) | literal no construtor de `Motor` | `ResourceLeaseService`/heartbeat do worker | Frequência de renovação de leases. Deve ser menor que o lease. |
| `motor.resource_wait_max_seconds` | `60` | default do argumento `ResourceLeaseService.acquire` | fila de recursos; reservado para reconciliador | Tempo máximo pretendido de espera por lock; atualmente `maxWaitSeconds` é reservado e não governa a espera efetiva. |
| `motor.console_run_absolute_timeout_ms` | `14400000` (4 h) | fallback em `ConsoleAgentRuntimeDriver.waitForRunCompletion` | polling de runs OpenClaw | Teto absoluto de uma execução remota. |
| `motor.console_run_idle_timeout_ms` | `600000` (10 min) | fallback em `ConsoleAgentRuntimeDriver.waitForRunCompletion` | polling de runs OpenClaw | Falha quando não há progresso/atividade pelo período configurado. |
| `motor.console_poll_interval_ms` | `5000` | fallback em `ConsoleAgentRuntimeDriver.waitForRunCompletion` | polling `describe/history` | Latência e volume de chamadas ao Console. |
| `motor.console_send_timeout_ms` | `600000` (10 min) | literal em `ConsoleAgentRuntimeDriver.sendMessage` | requisição HTTP de envio | Teto da chamada HTTP de envio; é diferente do tempo total do run. |
| `motor.dependency_install_timeout_ms` | `900000` (15 min) | `TASK_DEPENDENCY_INSTALL_TIMEOUT_MS`; fallback em `DependencyInstaller` | `npm ci`/recovery `npm install` | Impede instalação de dependências presa indefinidamente. |
| `motor.command_failure_excerpt_chars` | `12000` | `COMMAND_FAILURE_LIMIT` em `TaskWorker` | truncamento de falhas de comando | Controla tamanho de diagnóstico persistido/enviado. |
| `motor.worker_shutdown_timeout_ms` | `10000` | default de `WorkerLauncher.shutdownAll/stopWorker` | encerramento de processos filhos | Tempo de graceful shutdown antes de considerar o worker encerrado. |
| `motor.resource_event_wait_timeout_ms` | `30000` | default de `ResourceEventBus.waitFor` | espera por evento de recurso | Evita espera sem fim na retomada da fila. |
| `motor.baseline_confirmation_timeout_ms` | `300000` (5 min) | fallback de `BaselineConfirmation` | comando de confirmação de baseline | Tempo de validação da suíte/base antes de execução. |
| `motor.gate_failure_classifier_timeout_ms` | `240000` (4 min) | `DEFAULT_CONFIG` de `GateFailureClassifier` | chamada do monitor de classificação | Tempo por tentativa do classificador; falha aberta quando excede. |
| `motor.monitor_max_wait_seconds` | `600` (10 min) | `MotorMonitorStep.DEFAULT_CONFIG` | fila do recurso do monitor | Tempo de espera para obter o recurso exclusivo do monitor. |
| `motor.monitor_max_attempts` | `60` | `MotorMonitorStep.DEFAULT_CONFIG` | polling do monitor | Número máximo de verificações antes de timeout. |
| `motor.monitor_heartbeat_interval_ms` | `5000` | `MotorMonitorStep.DEFAULT_CONFIG` | renovação/polling do monitor | Intervalo de heartbeat; timeout derivado de `maxAttempts * heartbeatIntervalMs` (5 min). |
| `motor.setup_smoke_timeout_ms` | `10000` (10 s) | fallback de `SetupSmokeTest` | requisição HTTP do smoke test | Tempo máximo do teste funcional inicial. |
| `motor.carry_over_digest_lines` | `40` | `DEFAULT_DIGEST_LINES` | `digestGateFailure` | Quantidade de linhas levadas entre tentativas/gates. |
| `motor.carry_over_digest_chars` | `6000` | `DEFAULT_DIGEST_CHARS` | `digestGateFailure` | Limite de caracteres do resumo de contexto. |
| `motor.carry_over_events` | `6` | `MAX_CARRY_OVER_EVENTS` | composição do contexto de retry | Quantidade de eventos históricos reaproveitados. |
| `motor.carry_over_chars` | `8000` | `MAX_CARRY_OVER_CHARS` | composição do contexto de retry | Limite total do histórico carregado. |
| `motor.carry_over_reason_chars` | `1200` | `REASON_DIGEST_CHARS` | resumo de motivos | Limite por motivo de gate. |
| `motor.config_lint_max_depth` | `5` | `MAX_DEPTH` em `ConfigLintPolicy` | varredura de arquivos do lint | Profundidade máxima inspecionada. |
| `motor.config_lint_max_files` | `100` | `MAX_FILES` em `ConfigLintPolicy` | varredura de arquivos do lint | Proteção contra varredura excessiva. |

## Configurações por tarefa/projeto já persistidas

Estas não são defaults globais da tela; são valores de domínio que o motor já lê e deve continuar priorizando sobre defaults globais:

| Nome | Valor inicial/atual | Origem | Consumidores |
|---|---:|---|---|
| `tarefas.max_rework` | `3` | coluna `tarefas.max_rework` / migration `0000`; default de inserts e mapeamentos | `TaskCoordinator`, `ResourceWaitManager`, fluxo de rework |
| `tarefas.hard_timeout_ms` | `3600000` (1 h) no schema/insert; `14400000` no fallback de execução do coordenador | coluna da tarefa; `0000`, `0010`, `DrizzleDb`, `TaskCoordinator` | timeout do worker e contexto da subtarefa |
| `tarefas.build_command` | `npm run build` | coluna; fallback de `TaskCoordinator`/`ResourceWaitManager` | gate de build |
| `tarefas.unit_test_command` | `npm run test` | coluna; fallback de `TaskCoordinator`/`ResourceWaitManager` | gate de testes |
| `projeto_model_selection` | sem default global; cadeia cadastrada por projeto/fase | banco, fases `analysis`, `development`, `monitor` | seleção de modelos do analista, executor e classificador |
| `prompts_agentes`/versões | catálogo embutido como fallback; versão ativa do banco prevalece | banco + `prompt-catalog.ts`/`prompt-defaults.generated.ts` | composição dos prompts e contratos de saída |

## Configurações de ambiente e infraestrutura (visualização, não edição operacional)

Foram encontrados: `MOTOR_PROJECT_ID` (default `640`), `MYSQL_HOST` (varia: `localhost`/`mysql`), `MYSQL_PORT` (`3308` no `DrizzleDb`, `3306` nos scripts/worker), `MYSQL_USER`, `MYSQL_PASSWORD`, `GERENTE_AGENTES_DATABASE` (default `projeto_640`), `MOTOR_WORKSPACE_ROOT` (default `/tmp/motor-v2-workspaces`), `DEPLOY_REPO_HOST`, `TASK_SECRETS_ROOT`, `TASK_ENVIRONMENT` (default `development`), `OPENCLAW_CONSOLE_URL`, `OPENCLAW_CONSOLE_TOKEN`, `LIBRARY_REALTIME_EVENTS_URL` e `LIBRARY_REALTIME_EVENTS_TOKEN`, além de `MOTOR_LOG_LEVEL`, `MOTOR_LOG_FILE` e `MOTOR_LOG_FORMAT`.

Esses valores podem ser exibidos como diagnóstico (com segredos mascarados), mas não devem ser editáveis pela tela de configurações operacionais: credenciais, endpoints, caminhos de host, banco e segredos pertencem ao deploy/ambiente e uma alteração em runtime pode interromper o motor ou expor dados.

## Valores que não devem virar campos editáveis

- Limites de segurança e integridade: `COMMAND_FAILURE_LIMIT`, `MAX_DEPTH`, `MAX_FILES`, padrões de validação, transições de estado, `BASELINE_TEST_EXCLUDES` e fingerprints de baseline.
- Identidade e autorização: tokens, `OPENCLAW_CONSOLE_TOKEN`, `LIBRARY_REALTIME_EVENTS_TOKEN`, `TASK_SECRETS_ROOT`, chaves SSH e comandos remotos.
- Contratos e comportamento invariável: catálogo de prompts/contratos, tipos/status, nomes de recursos (`RESOURCE_KEYS`), classificação de falhas e políticas de promoção.
- IDs e rotas de infraestrutura: `MOTOR_PROJECT_ID`, host/porta/usuário/senha do MySQL, `MOTOR_WORKSPACE_ROOT`, `DEPLOY_REPO_HOST`, URLs e porta HTTP. Devem ser somente leitura ou geridos pelo ambiente.

## Achados para a próxima implementação

1. O limite global de paralelo está em `MOTOR_MAX_WORKERS`, com fallback `1`; o `README` cita `MAX_WORKERS=2`, mas o código efetivamente inicializa `1` quando a variável não é definida.
2. Há defaults duplicados para timeout de tarefa: schema/insert usam `1 h`, enquanto o coordenador usa `4 h` quando não há valor. A tela deve mostrar a origem e não esconder essa divergência.
3. `reconciler.maxStalenessMs` e `ResourceLeaseService.maxWaitSeconds` são pontos configuráveis na API interna, porém hoje não controlam integralmente o comportamento. Não devem ser apresentados como efetivos sem correção posterior.
4. A futura tela deve persistir os parâmetros globais em uma tabela própria/versionada, validar tipo/faixa e fazer o motor carregá-los na inicialização; não deve alterar `.env`, credenciais ou arquivos de configuração do OpenClaw.
