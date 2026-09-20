# Governança de comandos e observabilidade operacional

**Decisão registrada:** 20/09/2026  
**Estado:** em implementação — Fase 1 iniciada  
**Escopo inicial:** `TASK_RESUME_REQUESTED`

## Decisão

Todo comando recebido pelo Motor deve produzir uma trilha persistida e
consultável. Essa trilha precisa informar qual política foi avaliada, a decisão
tomada, a action selecionada (quando houver), cada primitive executada e seu
resultado. Uma rejeição também é uma decisão e deve ficar registrada.

Comandos não são eventos classificados pelo `EventClassifier`. Eles são uma
categoria própria: mensagens de intenção recebidas pela API, outbox ou fila. O
catálogo de eventos permanece destinado a resultados e ocorrências detectadas
automaticamente.

## Fluxo-alvo

```text
QueueMessage
  -> motor_commands
  -> motor_command_policies (em ordem de prioridade)
  -> guardas tipadas e claim transacional
  -> motor_actions / ActionExecutor
  -> motor_operation_log (linha para cada etapa)
```

Para `TASK_RESUME_REQUESTED`, o contrato inicial será:

```text
C03_TASK_RESUME_REQUESTED
  -> P03_RESUME_IF_ELIGIBLE
  -> A21_RESUME_TASK_ANALYSIS
  -> claim_analysis_atomic
  -> emit_analysis_selected
  -> start_analyst
```

`claim_analysis_atomic` é uma primitive protegida: sua transação e suas
invariantes permanecem em código. Configurar uma política nunca poderá burlar
pausa, bloqueio, término, plano já criado ou concorrência de análise.

## Schema necessário

```sql
CREATE TABLE motor_commands (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  message_type VARCHAR(200) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  scope ENUM('global','projeto','tarefa','subtarefa') NOT NULL DEFAULT 'tarefa',
  handler_code VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE motor_command_policies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  command_id INT UNSIGNED NOT NULL,
  code VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  conditions_json JSON NOT NULL,
  action_id INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_command_policy_command FOREIGN KEY (command_id)
    REFERENCES motor_commands(id) ON DELETE CASCADE,
  CONSTRAINT fk_command_policy_action FOREIGN KEY (action_id)
    REFERENCES motor_actions(id) ON DELETE RESTRICT,
  INDEX idx_command_policy_lookup (command_id, active, priority)
);

CREATE TABLE motor_operation_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  operation_id CHAR(36) NOT NULL,
  sequence INT UNSIGNED NOT NULL,
  phase ENUM('received','decision','action','primitive','completed','failed','rejected') NOT NULL,
  outcome ENUM('pending','executed','skipped','rejected','succeeded','failed') NOT NULL,
  message_id VARCHAR(200) NOT NULL,
  message_type VARCHAR(200) NOT NULL,
  correlation_id VARCHAR(200) NULL,
  causation_id VARCHAR(200) NULL,
  tarefa_id VARCHAR(100) NULL,
  subtarefa_id INT NULL,
  command_code VARCHAR(100) NULL,
  policy_code VARCHAR(100) NULL,
  policy_version INT UNSIGNED NULL,
  action_code VARCHAR(100) NULL,
  action_snapshot_json JSON NULL,
  primitive_code VARCHAR(100) NULL,
  input_json JSON NULL,
  result_json JSON NULL,
  reason_code VARCHAR(100) NULL,
  duration_ms INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_operation_sequence (operation_id, sequence),
  INDEX idx_operation_message (message_id),
  INDEX idx_operation_task_time (tarefa_id, created_at),
  INDEX idx_operation_correlation (correlation_id)
);
```

`conditions_json` aceita somente predicados tipados e permitidos pelo código;
não aceita SQL. O schema inicial de retomada é:

```json
{
  "all": [
    "task_not_paused",
    "task_not_terminal",
    "task_not_blocked",
    "task_has_no_subtasks",
    "analysis_not_claimed"
  ]
}
```

## Etapas de desenvolvimento

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Documento de decisão, schema e plano | Concluída |
| 2 | Migration e seeds de comando/política/action | Concluída no código; pendente aplicar a migration |
| 3 | Resolvedor de política e gravador append-only de operações | Concluída em módulos isolados; pendente integração |
| 4 | Primitives de ciclo de vida e integração de `TASK_RESUME_REQUESTED` | Concluída |
| 5 | API/timeline operacional e testes de concorrência, rejeição e auditoria | Em andamento |
| 6 | Migrar os demais comandos (`pause`, `cancel`, `enqueue`, `pump`) | Pendente |

## Progresso registrado

### 20/09/2026 — Fase 1

- Confirmado que o fluxo atual de retomada usa regras diretas no
  `TaskCoordinator`; não consulta `motor_actions`.
- Confirmado que existe `motor_event_log`, mas o sink atual do `EventLogger`
  persiste apenas em memória/stdout; a escrita em banco ainda é futura.
- Definido o modelo de catálogo de comandos, políticas tipadas e trilha
  operacional imutável acima.

### 20/09/2026 — Fases 2 e 3

- Criada a migration canônica
  `migrations/0054_motor_command_governance.sql`. Ela cria `motor_commands`,
  `motor_command_policies` e `motor_operation_log`, e registra o primeiro
  conjunto `C03_TASK_RESUME_REQUESTED` -> `P03_RESUME_IF_ELIGIBLE` ->
  `A21_RESUME_TASK_ANALYSIS`.
- Criado `CommandPolicyResolver`: avalia apenas condições fechadas/validadas e
  produz decisão explícita com `reasonCode` auditável quando rejeita.
- Criado `MySqlOperationLogger`: grava uma timeline append-only em
  `motor_operation_log`.
- Testes unitários do resolvedor: 7 aprovados. Typecheck do Motor v3 aprovado.

### Limite atual conhecido

- A migration criada ainda precisa entrar no fluxo de aplicação de migrations
  do repositório/deploy antes de existir no banco de produção.
- O `TaskCoordinator` agora consulta o comando por `message_type`, avalia
  `P03_RESUME_IF_ELIGIBLE`, seleciona `A21_RESUME_TASK_ANALYSIS` e registra as
  primitives `claim_analysis_atomic`, `emit_analysis_selected` e
  `start_analyst`. A execução preserva o claim transacional existente.
- A API expõe `GET /gerenteagentes/tarefas/:id/operacoes-motor`; a aba **Logs**
  do Mapa de agentes mostra a timeline de comando, política, action, primitive
  e resultado.
- A migration `0054_motor_command_governance.sql` foi registrada no journal do
  GerenteAgentes; falta aplicá-la no deploy e completar testes contra MySQL real
  para a timeline.

### Próximo trabalho

### 20/09/2026 — início da execução event-driven

- Criado `DevelopmentExecutionConsumer` para consumir a mensagem durável
  `TASK_READY_FOR_PROGRAMMING`.
- Criado `MySqlDevelopmentExecutionRepository`: seleciona a primeira
  subtarefa elegível respeitando ordem, dependências, bloqueios e subtarefas
  ativas; altera `pending` para `running` com claim condicional.
- O claim e a gravação de `SUBTASK_EXECUTION_REQUESTED` no `motor_outbox`
  acontecem na mesma transação, evitando subtarefa `running` sem mensagem
  durável correspondente.
- Criada uma porta durável explícita no `TaskCoordinator` para gravar
  `TASK_READY_FOR_PROGRAMMING` no `motor_outbox`. A publicação não depende do
  `MessageBus`, pois ele captura falhas de handlers; erro de outbox agora é
  propagado ao consumidor RabbitMQ e permite retry.
- Registrada a operação no `motor_operation_log`, incluindo recebimento,
  `claim_subtask_atomic`, resultado e o identificador da próxima mensagem.
- Testes do novo consumidor e do fluxo completo adicionados; suíte do Motor v3
  com 140 testes aprovados e typecheck aprovado.

### 20/09/2026 — consumidor do programador

- Criado `SubtaskExecutionConsumer` para consumir
  `SUBTASK_EXECUTION_REQUESTED`.
- O consumidor recarrega do banco tarefa, subtarefa, projeto, agente e comandos
  de build/teste; mensagens sem subtarefa `running` são ignoradas de forma
  idempotente.
- Criado `GitWorktreePreparer`: gera um worktree isolado sem trocar o checkout
  da branch base e persiste caminho, branch e commit-base na subtarefa.
- Criado `WorkerConsoleAdapter` para compatibilizar o contrato tipado do Console
  usado pelo analista com as primitivas legadas do `WorkerLauncher`.
- O `WorkerLauncher` agora recebe os comandos de build/teste configurados no
  projeto; corrigida também a contagem dupla de tentativas em exceções.
- Ao terminar, status e próxima mensagem são gravados na mesma transação:
  `delivered + SUBTASK_EXECUTION_COMPLETED` ou
  `failed + SUBTASK_EXECUTION_FAILED`.
- A timeline registra recebimento, preparação do worktree, execução do
  programador e mensagem resultante.

### 20/09/2026 — verificação, integração e conclusão

- `SUBTASK_EXECUTION_COMPLETED` agora altera `delivered -> verifying` e publica
  `SUBTASK_VERIFICATION_REQUESTED` na mesma transação.
- O consumidor de verificação executa novamente os comandos configurados de
  build e testes, cria o commit da subtarefa e integra por `cherry-pick` em um
  worktree exclusivo da tarefa.
- O checkout do repositório base não é alterado e não há push nem deploy
  implícitos.
- Commit e integração são idempotentes: um retry após sucesso do Git e falha
  posterior do banco reutiliza o commit e reconhece que ele já foi integrado.
- Após a verificação, a subtarefa passa para `verified`; o Motor publica
  `SUBTASK_VERIFIED` e, atomicamente, reserva/publica a próxima
  `SUBTASK_EXECUTION_REQUESTED`.
- Quando todas as subtarefas estão `verified`/`superseded`, o Motor registra
  `terminal_status=completed`, confirma a integração e publica
  `TASK_EXECUTION_COMPLETED`.

### Limite atual

O fluxo event-driven agora chega até `completed`. Publicação remota, promoção
para a branch base e deploy permanecem etapas separadas e ainda não são
acionadas automaticamente pelo Motor v3.

### 20/09/2026 — capacidade de desenvolvimento

- O claim da primeira subtarefa consulta `motor.max_workers` e
  `motor.max_workers_per_project` na mesma transação e serializa concorrência
  bloqueando os registros de configuração.
- Sem vaga global ou do projeto, a tarefa é persistida em
  `motor_execution_wait_queue`; sua subtarefa continua `pending`.
- Ao concluir uma tarefa ou liberar a vaga por falha de execução, o Motor
  publica novos `TASK_READY_FOR_PROGRAMMING` para as entradas aguardando.
  Cada uma ainda passa pelo claim atômico, portanto os limites permanecem
  respeitados sem `pump` nem polling de decisão.
