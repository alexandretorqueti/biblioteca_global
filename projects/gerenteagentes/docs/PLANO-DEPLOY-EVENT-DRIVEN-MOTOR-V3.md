# Plano — Deploy event-driven no Motor v3

**Estado:** proposta de implementação  
**Objetivo:** entregar ao Motor v3 as capacidades de promoção e deploy
blue-green do Motor v2, preservando a arquitetura do v3: comandos recebidos,
políticas, actions, primitives protegidas, outbox transacional, RabbitMQ,
eventos de domínio e reconciliação idempotente.

## Resultado esperado

Uma tarefa de desenvolvimento integrada e com gate aprovado pode ser
explicitamente solicitada para deploy. O Motor v3 valida e persiste a intenção,
agrupa solicitações compatíveis, executa o deploy blue-green no host e
reconcilia seu resultado. A tarefa só se torna `deployed` após confirmação
persistida de sucesso.

O deploy **não** será uma chamada HTTP síncrona que executa Git, SSH ou Docker
diretamente. Todo efeito externo será disparado por uma mensagem durável e terá
chave de idempotência, correlação, causação e trilha em `motor_operation_log`.

## Princípios obrigatórios

1. A API recebe intenção; não executa deploy.
2. Todo comando entra no `motor_outbox` na mesma transação da alteração de
   estado correspondente.
3. Um consumidor traduz comando em decisão de política, action e primitives;
   ele não contém regras soltas de negócio.
4. Ação externa (SSH/script) é assíncrona, idempotente e reconciliável após
   reinício.
5. Eventos descrevem fatos consumados. Comandos descrevem intenção. Não usar
   um evento como pedido de deploy.
6. Claims, locks, promoção Git, criação de lote e transições de estado são
   primitives tipadas e transacionais; não configuráveis por JSON livre.
7. O script blue-green existente continua sendo a fronteira de infraestrutura.
   O Motor v3 apenas o invoca e reconcilia o marcador/resultados.
8. Nenhuma etapa faz push ou deploy implícito na conclusão da programação. O
   deploy permanece uma decisão explícita, tal como no v2.

## Fluxo-alvo

```text
API
  -> motor_outbox: DEPLOY_REQUESTED (comando)
  -> RabbitMQ
  -> QueueConsumer / CommandProcessor
  -> política Pxx + action Axx
  -> primitives: validar, gate, criar deploy_request, emitir fato
  -> DEPLOY_REQUEST_ACCEPTED (evento)

Scheduler/consumidor de orquestração
  -> motor_outbox: DEPLOY_BATCH_DISPATCH_REQUESTED (comando)
  -> RabbitMQ
  -> política Pxx + action Axx
  -> primitives: claim do lote, promover, iniciar script remoto
  -> DEPLOY_BATCH_STARTED (evento)

Reconciliador
  -> lê status remoto/marcador
  -> primitives: concluir ou falhar lote
  -> DEPLOY_BATCH_SUCCEEDED | DEPLOY_BATCH_FAILED (eventos)
  -> TASK_DEPLOYED | TASK_DEPLOY_BLOCKED (eventos por tarefa)
```

Todos os comandos e eventos devem conter `messageId`, `correlationId`,
`causationId`, `taskId` quando aplicável, `executionId`/`batchId` quando
aplicável e `attempt`. O `batchId` será a chave de idempotência do efeito
remoto; o script recebe também o commit esperado.

## Etapa 0 — Consolidar o contrato antes de codificar

1. Registrar no catálogo os comandos, eventos, actions e primitives abaixo.
2. Definir os payloads TypeScript e os schemas persistidos. Payloads devem ser
   mínimos, serializáveis e sem conexões/sessões.
3. Fixar a branch-base por projeto na configuração existente. Não usar `main`
   fixo; para este projeto a base é `base-desenvolvimento`.
4. Definir o contrato do script blue-green: parâmetros, arquivo/marcador de
   status, códigos de saída, timeout, slot e commit publicado.
5. Definir qual actor pode emitir `DEPLOY_REQUESTED` e como uma solicitação é
   cancelada antes de ser claimed.

### Catálogo mínimo

| Categoria | Código | Finalidade |
|---|---|---|
| Comando | `DEPLOY_REQUESTED` | Solicitação explícita de deploy de uma tarefa concluída. |
| Comando | `DEPLOY_BATCH_DISPATCH_REQUESTED` | Pede a execução de um lote já persistido. |
| Comando | `DEPLOY_RECONCILIATION_REQUESTED` | Pede reconciliação de lote `running` ou pendente. |
| Evento | `DEPLOY_REQUEST_ACCEPTED` | Solicitação persistida e elegível. |
| Evento | `DEPLOY_REQUEST_REJECTED` | Solicitação recusada, com motivo. |
| Evento | `DEPLOY_BATCH_READY` | Lote persistido, aguardando ociosidade/claim. |
| Evento | `DEPLOY_BATCH_STARTED` | Processo remoto iniciado e identificado. |
| Evento | `DEPLOY_BATCH_SUCCEEDED` | Marcador remoto confirmou publicação. |
| Evento | `DEPLOY_BATCH_FAILED` | Execução remota falhou ou expirou. |
| Evento | `TASK_DEPLOYED` | Tarefa do lote passou a `deployed`. |
| Evento | `TASK_DEPLOY_BLOCKED` | Tarefa foi bloqueada por falha definitiva. |
| Action | `Axx_ACCEPT_DEPLOY_REQUEST` | Valida e persiste a solicitação. |
| Action | `Axx_DISPATCH_DEPLOY_BATCH` | Faz claim, promove e inicia a execução remota. |
| Action | `Axx_RECONCILE_DEPLOY_BATCH` | Conclui ou falha lote a partir de estado observável. |

Primitives protegidas propostas: `assert_deploy_eligible`,
`run_pre_deploy_gate`, `upsert_deploy_request`, `claim_deploy_batch_atomic`,
`promote_commit_to_base`, `start_remote_blue_green`,
`read_remote_deploy_status`, `complete_deploy_batch_atomic` e
`fail_deploy_batch_atomic`.

## Etapa 1 — Persistência e migrations canônicas

1. Revisar e aproveitar `deploy_requests` existente; não criar uma segunda
   fonte de verdade. Completar apenas as colunas/índices que faltarem para:
   `task_id`, `repository`, `requested_commit`, `status`, `batch_id`,
   `requested_at`, `started_at`, `finished_at`, `last_error` e idempotência.
2. Criar uma entidade persistida de lote, por exemplo `deploy_batches`, com
   `batch_id`, repositório, branch-base, commit esperado, status, lock/claim,
   PID ou identificador remoto, slot, timeout e detalhes de erro.
3. Criar relação lote-solicitação (`deploy_batch_requests`) se um lote puder
   conter várias tarefas. Ela permite reconciliação e transição atômica por
   tarefa.
4. Adicionar comandos, políticas e actions no catálogo e registrar a migration
   no journal canônico de `projects/gerenteagentes/migrations`.
5. Usar `motor_operation_log` para todas as decisões, actions e primitives;
   não criar log paralelo para esconder o fluxo.
6. Criar índices de claim e consulta operacional: status/tempo, repositório,
   `batch_id`, `task_id` e `requested_commit`.

Critério: uma solicitação, lote e suas transições podem ser recuperados do
banco sem depender de memória do processo ou de logs Docker.

## Etapa 2 — Entrada pela API e comando durável

1. Criar no Motor v3 o endpoint de solicitação de deploy, mantendo o contrato
   público que a API usa ou adaptando a API para o endpoint v3 quando
   `MOTOR_VERSION=v3`.
2. Validar somente autorização e formato na borda. A elegibilidade de negócio
   é avaliada pelo comando/política.
3. Gravar `DEPLOY_REQUESTED` em `motor_outbox` com `messageId` idempotente por
   solicitação do usuário e com correlação da tarefa.
4. Publicar apenas após o commit da transação; o publicador existente trata
   RabbitMQ indisponível e o dreno no boot.
5. Retornar `202 Accepted` com o identificador da solicitação. Não aguardar
   gate, SSH ou Docker na requisição HTTP.

Critério: repetição da mesma requisição não cria duas solicitações nem dois
lotes; queda entre commit e publicação é recuperada pelo outbox.

## Etapa 3 — Aceitação da solicitação por política/action

1. O `QueueConsumer` entrega `DEPLOY_REQUESTED` ao processador de comandos.
2. Registrar fases `received` e `decision` em `motor_operation_log`.
3. A política de elegibilidade deve exigir, no mínimo:
   - tarefa de desenvolvimento;
   - tarefa `completed`, não pausada, não cancelada e não bloqueada;
   - integração confirmada;
   - commit de integração identificado e imutável;
   - nenhuma solicitação/lote ativo incompatível;
   - branch-base e repositório configurados.
4. A action executa `run_pre_deploy_gate` contra o commit exato, em worktree
   isolado, e persiste o resultado do gate/test run.
5. Falha de gate emite `DEPLOY_REQUEST_REJECTED`; não inicia efeito remoto e
   mantém a tarefa em `completed` com diagnóstico.
6. Sucesso executa `upsert_deploy_request`, cria a mensagem
   `DEPLOY_BATCH_DISPATCH_REQUESTED` no outbox na mesma transação e emite
   `DEPLOY_REQUEST_ACCEPTED`/`DEPLOY_BATCH_READY`.

Critério: nenhum deploy pode começar sem gate verde associado ao mesmo commit
que será promovido/publicado.

## Etapa 4 — Agrupamento e claim seguro do lote

1. No processamento de `DEPLOY_BATCH_DISPATCH_REQUESTED`, buscar solicitações
   `pending` do mesmo repositório e mesma branch-base, compatíveis com o mesmo
   commit a publicar.
2. Antes do claim, verificar ociosidade através de fatos persistidos: workers,
   subtarefas em estado ativo, integrações/finalizações pendentes e outro lote
   ativo para o repositório. Não deduzir ociosidade apenas por memória local.
3. Se não estiver ocioso, reagendar o comando com atraso durável (TTL/retry ou
   mensagem de agendamento definida no catálogo), sem busy loop.
4. `claim_deploy_batch_atomic` cria ou reclama um único lote e move as
   solicitações selecionadas para `running` na mesma transação.
5. A primitive deve impedir lotes concorrentes do mesmo repositório e tolerar
   reentrega da mesma mensagem. Projetos/repositórios distintos podem avançar
   independentemente quando a infraestrutura permitir.
6. Após o claim, registrar a action e publicar `DEPLOY_BATCH_STARTED` somente
   depois de persistir o identificador do processo remoto ou sua intenção de
   inicialização.

Critério: duas mensagens/reinícios concorrentes não publicam o mesmo lote duas
vezes e não misturam commits diferentes.

## Etapa 5 — Promoção Git como primitive controlada

1. Implementar `promote_commit_to_base` em um worktree próprio do lote; nunca
   no checkout base compartilhado e nunca no worktree de desenvolvimento.
2. Conferir que o commit aprovado continua sendo o esperado e que a árvore de
   trabalho está limpa antes da promoção.
3. Aplicar a estratégia aprovada (merge/cherry-pick) para a branch-base do
   projeto e registrar commit de destino e evidência no lote.
4. Fazer push somente nessa primitive, após a promoção e dentro do lock/claim.
5. Tornar a operação idempotente: em retry, reconhecer commit já contido na
   branch-base e não duplicar push/merge.
6. Em conflito ou divergência, falhar o lote de modo recuperável, sem alterar
   o checkout base e sem iniciar o deploy blue-green.

Critério: o commit que o script receberá está na branch-base remota e é
exatamente o commit aprovado pelo gate ou sua promoção identificada.

## Etapa 6 — Adaptador para o deploy blue-green remoto

1. Criar uma porta/adaptador de infraestrutura, por exemplo
   `RemoteBlueGreenDeployer`, injetada na action; primitives de domínio não
   executam SSH diretamente.
2. O adaptador invoca o script existente no ServerIA com parâmetros explícitos:
   repositório, branch-base, commit esperado, `batchId`, arquivo/marcador de
   status e timeout.
3. O script preserva o slot ativo até health checks do novo slot concluírem;
   sua semântica blue-green atual deve ser mantida.
4. Persistir antes de retornar o identificador remoto (PID, status path ou
   token). A action então emite `DEPLOY_BATCH_STARTED` e grava a próxima
   `DEPLOY_RECONCILIATION_REQUESTED` no outbox.
5. Falha de transporte SSH antes de iniciar o processo deve liberar/reagendar
   de maneira segura, registrando a primitive como falha transitória. Falha
   após iniciar o processo exige reconciliação, não uma segunda execução.

Critério: o Motor pode cair após o SSH sem perder a capacidade de descobrir se
o processo remoto foi iniciado ou terminou.

## Etapa 7 — Reconciliação orientada por mensagem

1. Um agendador controlado emite `DEPLOY_RECONCILIATION_REQUESTED` para lotes
   `running`, incluindo os encontrados no boot. Ele não altera estados por
   conta própria.
2. A action de reconciliação chama `read_remote_deploy_status` e grava a
   evidência observada na operação.
3. Se houver sucesso, `complete_deploy_batch_atomic` atualiza lote,
   solicitações e tarefas relacionadas. Na mesma transação, grava no outbox
   `DEPLOY_BATCH_SUCCEEDED` e um `TASK_DEPLOYED` por tarefa.
4. Se houver falha definitiva ou timeout, `fail_deploy_batch_atomic` atualiza
   lote e solicitações, registra `last_error`, bloqueia as tarefas conforme a
   regra vigente e emite `DEPLOY_BATCH_FAILED` e `TASK_DEPLOY_BLOCKED`.
5. Ausência de marcador antes do timeout não é sucesso. Após o timeout, é
   falha diagnosticável; o slot anterior deve permanecer servido.
6. A entrega repetida deve ler o estado final e encerrar sem duplicar eventos
   ou mudar uma tarefa já `deployed`.

Critério: não há lote `running` órfão após reinício, e a transição a
`deployed` nunca depende de a API permanecer no ar durante o blue-green.

## Etapa 8 — Consultas, API e observabilidade

1. Expor diagnóstico do v3 por tarefa, solicitação e lote: estado, commit,
   branch, gate, slot, tempos, erro e links de correlação.
2. A API da Biblioteca deve apontar para o endpoint e diagnóstico do v3 quando
   `MOTOR_VERSION=v3`; não encaminhar silenciosamente operações ao v2.
3. Exibir a timeline de `motor_operation_log` com comando, política, action,
   primitive, decisão e resultado.
4. Expor eventos de deploy no catálogo e na timeline da tarefa.
5. Registrar métricas: solicitações pendentes, lotes running, duração, timeout,
   falhas por fase, retries, sucesso/falha por repositório e slot ativo.
6. Disponibilizar uma ação administrativa explícita de reconciliação/retry,
   protegida por política, sem editar banco manualmente.

## Etapa 9 — Testes e homologação

1. Unitários para políticas, primitives e transições idempotentes.
2. Integração MySQL para outbox, claim concorrente, criação de lote, recuperação
   após crash e operação log.
3. Testes de fila para ack/nack, reentrega, DLQ, correlação e causação.
4. Testes Git em repositório temporário: commit já promovido, conflito,
   divergência, push falho e retry seguro.
5. Contrato do adaptador SSH/script com fake controlável: processo iniciado,
   falha antes/depois do start, timeout, status inconclusivo e rollback do slot.
6. E2E blue-green em ambiente de homologação: health API/Motor/Web, troca de
   slot, preservação do slot anterior em erro e reconciliação após reinício do
   Motor.
7. Casos obrigatórios: deploy duplicado, duas tarefas do mesmo repositório,
   tarefas de commits diferentes, Motor reiniciado no meio, RabbitMQ
   indisponível, MySQL indisponível, SSH indisponível e gate vermelho.

## Ordem de entrega recomendada

1. Etapas 0 e 1: contrato, migration e testes de persistência.
2. Etapas 2 e 3: endpoint, outbox, política e gate sem efeito remoto.
3. Etapa 4: lote/claim/ociosidade com simulador de deploy.
4. Etapa 5: promoção Git isolada e idempotente.
5. Etapas 6 e 7: adaptador blue-green e reconciliação.
6. Etapa 8: API/timeline/diagnóstico.
7. Etapa 9: homologação progressiva; somente depois habilitar em produção.

## Fora de escopo desta implementação

- Alterar `compose.yaml`, configuração do Gateway ou topologia do OpenClaw.
- Reescrever o script blue-green sem necessidade comprovada.
- Retomar o Motor v2 como executor de deploy para tarefas v3.
- Fazer deploy automático ao terminar uma tarefa sem solicitação explícita.
