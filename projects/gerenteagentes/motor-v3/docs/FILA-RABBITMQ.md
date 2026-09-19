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

### Ciclo 3 — ciclo do analista

- criar o contexto de análise a partir da tarefa;
- chamar `WorkerLauncher` com a instrução correta;
- tratar resposta do analista e o marcador de conclusão;
- validar o plano recebido;
- persistir o plano aprovado;
- criar subtarefas `pending` na ordem definida;
- publicar `ANALYSIS_COMPLETED` e `TASK_READY_FOR_PROGRAMMING`.

### Ciclo 4 — outbox transacional

- criar tabela/repositório de outbox no banco do motor;
- registrar criação/destravamento e mensagem na mesma transação;
- publicar mensagens pendentes com segurança após commit;
- marcar publicação confirmada;
- impedir perda entre banco e RabbitMQ;
- definir idempotência persistida por `messageId`.

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
