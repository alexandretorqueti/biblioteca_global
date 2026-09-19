# Fila durável do Motor v3

## Objetivo

O Motor v3 usa o `MessageBus` para comunicação interna dentro do processo e
RabbitMQ para comandos/eventos que não podem desaparecer quando o motor é
reiniciado.

O RabbitMQ não substitui o `MessageBus`: ele entrega a mensagem ao motor; o
`QueueConsumer` valida e confirma a entrega; depois o componente de domínio
(`TaskCoordinator`, na próxima etapa) decide qual reação executar.

```text
API/Biblioteca
    │ mensagem persistente
    ▼
RabbitMQ (exchange + fila + DLQ)
    │ entrega manual
    ▼
QueueConsumer
    │ somente após handler concluir
    ▼
TaskCoordinator → MessageBus → ações/primitivas/WorkerLauncher
```

## Contrato

Toda mensagem externa usa `QueueMessage`:

- `messageId`: identificador único para idempotência;
- `type`: comando ou evento, por exemplo `TASK_CREATED`;
- `taskId` e `executionId`: contexto da tarefa;
- `payload`: dados específicos do comando/evento;
- `timestamp`, `correlationId` e `causationId`: rastreabilidade;
- `attempt`: tentativa lógica de processamento.

O payload precisa ser JSON serializável. Não deve conter sessão, conexão,
função ou outro objeto do processo.

## Confirmação e falhas

1. O consumidor recebe a mensagem com `ack` manual.
2. O handler é executado.
3. O `ack` só é enviado depois que o handler termina com sucesso.
4. Uma falha é rejeitada sem requeue pelo consumidor atual, para que a
   topologia do RabbitMQ encaminhe a mensagem à DLQ.
5. Retry com atraso será adicionado junto com a configuração de DLQ/retry e
   política de idempotência persistida.

O conjunto `processed` do `QueueConsumer` evita duplicação dentro do processo,
mas não é a garantia final de idempotência. A próxima etapa deverá persistir o
`messageId` processado ou usar uma chave única equivalente antes de executar
efeitos irreversíveis.

## Topologia esperada

O adaptador declara um exchange `direct` durável. Ao iniciar o consumo, ele
declara a fila durável e a associa ao exchange usando o nome da fila como
routing key. O deploy deverá criar, adicionalmente, as filas de retry e DLQ
com as políticas de TTL e dead-letter exchange.

O código não instala nem configura RabbitMQ no host. A conexão só será ativada
quando o serviço receber uma URL e uma topologia de produção por configuração.

## Estado desta implementação

Implementado neste ciclo:

- contrato e criação de mensagens;
- transporte RabbitMQ com publisher confirms;
- consumidor com `ack`/`nack` manual;
- transporte em memória e testes unitários.

Ainda não implementado:

- outbox transacional entre `tarefas` e a mensagem;
- `TaskCoordinator` para análise e subtarefas;
- conexão do endpoint HTTP ao RabbitMQ;
- instalação/configuração do RabbitMQ no ServerIA;
- retry/DLQ de produção e idempotência persistida.

Esses itens ficam separados para não publicar uma tarefa antes de a transação
que a criou estar confirmada e para não iniciar o motor com uma fila sem
coordenador conectado.

## Roadmap de implementação

Esta é a ordem definida para concluir o fluxo de criação/destravamento até o
fim da análise. Cada ciclo deve manter testes e documentação atualizados.

### Ciclo 1 — transporte durável ✅

- contrato `QueueMessage` serializável;
- `RabbitMqTransport` com mensagens persistentes e publisher confirms;
- `QueueConsumer` com `ack` manual;
- transporte em memória para testes;
- documentação dos limites do transporte.

### Ciclo 2 — `TaskCoordinator` ✅

- criado `src/coordinator/TaskCoordinator.ts`;
- recebe `TASK_CREATED`, `TASK_ENQUEUED` e `TASK_RESUME_REQUESTED`;
- consulta o estado recebido pelo repositório e respeita pausa/cancelamento;
- exige `claimAnalysis` atômico para impedir duas análises simultâneas;
- separa decisão de análise da decisão de execução de subtarefa;
- publica eventos de seleção, início, encaminhamento e falha no `MessageBus`;
- cobre caminho feliz, pausa, plano existente, duplicidade, falha e comandos
  que não pertencem à análise.

O ciclo usa interfaces injetáveis de repositório e runner. Ainda não há
implementação MySQL nem chamada real ao `WorkerLauncher`; esses acoplamentos
ficam para os ciclos de persistência e do analista, depois da revisão do
contrato.

### Ciclo 2b — claim persistente da análise ✅

- adicionada a migration `0002_analysis_execution_claim`;
- `task_runtime_facts.analysis_execution_id` identifica o dono do claim;
- o repositório MySQL trava a tarefa, valida elegibilidade e grava o claim em
  transação;
- a liberação exige o mesmo `executionId`, evitando liberar outra análise;
- criado o adaptador `WorkerAnalysisRunner` para o `WorkerLauncher` existente;
- migration ainda não foi aplicada em produção.

### Ciclo 3 — ciclo do analista ✅

**Estado: implementado e integrado ao consumidor.**

- criado `ConsoleAnalystRunner`, separado do `WorkerLauncher` de programação;
- criado cliente HTTP mínimo do Console;
- resposta do analista aceita plano ou perguntas de clarificação;
- parser valida subtarefas, critérios, entregáveis e matriz de cobertura;
- plano é persistido em transação e cria subtarefas `pending` na ordem definida;
- perguntas são persistidas em `tarefa_chats`;
- claim só é liberado depois da persistência;
- publicados `ANALYSIS_COMPLETED`, `TASK_READY_FOR_PROGRAMMING` ou
  `ANALYSIS_CLARIFICATION_REQUESTED`;
- componentes montados no `start.ts` com configuração explícita e encerramento
  gracioso.

### Ciclo 4a — integração de inicialização ✅

- `start.ts` inicializa `RabbitMqTransport`, `QueueConsumer`,
  `TaskCoordinator`, repositório MySQL e `ConsoleAnalystRunner` quando
  `MOTOR_QUEUE_ENABLED=true`;
- o consumidor é encerrado no shutdown do processo;
- a integração exige explicitamente `MOTOR_RABBITMQ_URL`,
  `OPENCLAW_CONSOLE_URL` e `OPENCLAW_CONSOLE_TOKEN`;
- a flag permanece desativada por padrão;
- os endpoints HTTP encaminham comandos para o outbox quando a fila está ativa;
- o `MessageBus` permanece como fallback quando a fila está desativada.

### Ciclo 4b — outbox transacional do Motor ✅

- criada a tabela `motor_outbox` com `message_id` único;
- comandos HTTP passam pelo outbox quando `MOTOR_QUEUE_ENABLED=true`;
- a gravação ocorre antes da tentativa de publicação;
- a publicação é tentada imediatamente, sem polling periódico;
- mensagens pendentes são drenadas no boot do motor;
- falha do RabbitMQ mantém a mensagem `pending` com erro e contador de
  tentativas;
- publicação duplicada após crash é tolerada pelo `messageId` idempotente;
- o `MessageBus` continua sendo o fallback quando a fila está desativada.

O outbox implementado neste ciclo protege os comandos recebidos pelos
endpoints do Motor (`enqueue`, `pause`, `resume`, `cancel` e `pump`).

### Ciclo 4c — criação atômica da tarefa ✅

`GerenteAgentesService.criarTarefa` agora grava, na mesma transação do banco
do projeto 640:

- a tarefa e seu `external_id`;
- o evento de auditoria `created`;
- a mensagem `TASK_CREATED` na `motor_outbox`.

A tarefa continua nascendo pausada. Portanto, `TASK_CREATED` apenas registra a
existência no Motor; o destravamento gera o comando de retomada, que também
passa pelo outbox do Motor. Depois do commit, o publicador tenta enviar a
mensagem ao RabbitMQ e a deixa persistida como `pending` se o broker estiver
indisponível.

Limite atual: essa atomicidade vale porque a criação e `motor_outbox` estão no
mesmo banco. Uma criação feita por outro serviço ou por outro banco ainda
precisará de um outbox próprio nesse mesmo banco ou de uma operação transacional
compartilhada. Não é possível garantir atomicidade entre duas transações
independentes apenas com uma chamada HTTP.

Também não há polling periódico: se uma publicação falhar, a mensagem fica
`pending` e é reenviada no próximo ciclo de publicação (boot ou novo enqueue).
Um retry temporizado e uma DLQ serão tratados na etapa de operação do RabbitMQ.

Variáveis opcionais:

```text
MOTOR_RABBITMQ_EXCHANGE=motor
MOTOR_RABBITMQ_QUEUE=motor.commands
MOTOR_RABBITMQ_PREFETCH=1
MOTOR_QUEUE_MAX_ATTEMPTS=3
MOTOR_ANALYSIS_TIMEOUT_MS=1800000
MOTOR_ANALYSIS_POLL_INTERVAL_MS=5000
```

### Ciclo 5 — integração com API e MessageBus

- trocar os `bus.emit(...)` diretos dos endpoints por publicação na fila;
- manter o `MessageBus` apenas para eventos internos do processo;
- ligar `QueueConsumer → TaskCoordinator → MessageBus`;
- preservar compatibilidade das respostas HTTP;
- adicionar endpoints/telemetria de fila quando necessário.

### Ciclo 6 — execução de subtarefas

- selecionar subtarefas liberadas por dependências;
- aplicar limites de concorrência e locks;
- iniciar `WorkerLauncher` para o agente programador;
- tratar conclusão, falha, bloqueio e retry;
- conectar `Scheduler` à execução real;
- persistir transições e eventos operacionais.

### Ciclo 7 — RabbitMQ de produção

- definir URL e credenciais somente por ambiente/secrets;
- criar exchange, fila principal, filas de retry e DLQ;
- configurar TTL, limite de tentativas e dead-letter exchange;
- testar reinício do motor com mensagens pendentes;
- testar duplicação, falha do broker e recuperação;
- validar observabilidade no ServerIA.

### Ciclo 8 — piloto e ativação

- executar tarefa trivial de análise;
- executar tarefa com pausa e destravamento;
- confirmar que nenhuma mensagem é perdida;
- confirmar que análise cria as subtarefas corretas;
- acompanhar logs, eventos e DLQ;
- somente então ativar o fluxo para tarefas reais.

## Critérios de conclusão do fluxo inicial

O fluxo criação → pausa → destravamento → análise estará pronto quando:

1. a tarefa e a mensagem forem persistidas de forma atômica;
2. o destravamento publicar uma mensagem durável;
3. o consumidor receber a mensagem após reinício sem intervenção manual;
4. o coordenador iniciar uma única análise por tarefa;
5. o analista concluir e seu plano ficar persistido;
6. as subtarefas forem criadas sem duplicidade;
7. falhas forem encaminhadas para retry/DLQ;
8. testes automatizados cobrirem caminho feliz, duplicidade e reinício.

## Decisões ainda não autorizadas

Este documento não autoriza, por si só, mudanças de infraestrutura. Ainda
precisam ser avaliadas antes da execução:

- instalação ou alteração do RabbitMQ no ServerIA;
- criação de filas reais e políticas de DLQ;
- alteração do contrato público da API;
- mudança do banco ou migração de tabelas existentes.
