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
