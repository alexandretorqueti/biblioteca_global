# Especificação — chat em tempo real durante a execução da tarefa

**Status:** primeira entrega implementada em `exec/chat-tempo-real-execucao`, aguardando code review.  
**Data:** 2026-09-13  
**Escopo:** Motor-v2 e o detalhe da tarefa no **Mapa de agentes**. Não altera
configuração do OpenClaw, não faz commit nem deploy.

## 1. Objetivo

Transformar o chat da tarefa em um canal operacional bidirecional entre a
pessoa responsável e o agente que está analisando ou desenvolvendo. A pessoa
pode perguntar, corrigir rumo, fornecer dados ou pedir pausa; o agente recebe
a mensagem no contexto da mesma tarefa, responde e retoma o trabalho sem
perder o worktree, o histórico, a sessão ou o resultado dos testes já feitos.

O objetivo **não** é substituir controles técnicos. Build, testes, gates,
limites de tentativa, pausa, cancelamento e aprovação de deploy continuam
determinísticos. O chat resolve decisões humanas e ambiguidades que hoje se
transformam em reanálise, rework ou troca de modelo.

## 2. Estado atual confirmado no código

O Mapa de agentes já é a base correta para esta evolução:

- `screens/OperationMapScreen.tsx` abre um drawer da tarefa com as abas
  **Resumo, Chat, Execução, Logs e Histórico**;
- para a tarefa selecionada, ele abre `RealtimeClient` com `taskId` e recebe
  eventos WebSocket; já trata `task.chat.message.created` e atualiza a conversa
  sem polling quando recebe esse evento;
- `POST /gerenteagentes/tarefas/:id/chat` grava em `tarefa_chats`, publica o
  evento realtime e hoje só encaminha a mensagem ao Motor se a tarefa estiver
  em `awaiting_clarification`;
- `TaskCoordinator.answerClarification()` só aceita esse estado e o converte
  para `planned`, provocando **nova análise**;
- `TaskWorker` cria sessão do analista e do desenvolvedor, envia uma mensagem
  e aguarda a finalização do run. O driver atual expõe `createSession`,
  `sendMessage` e `waitForRunCompletion`; ele não expõe interrupção cooperativa
  de um run em andamento.

Portanto, o transporte até a tela já é em tempo real. A lacuna é uma fila
durável entre o chat e a sessão do agente, mais um protocolo de pausa/retomada
sem reanalisar a tarefa.

## 3. Decisões de produto

1. **Chat é livre; ações críticas são explícitas.** Uma mensagem normal nunca
   faz commit, deploy, exclusão, migração ou cancelamento por inferência de
   linguagem natural. Essas ações continuam em botões/confirmadores próprios.
2. **O autor vem da sessão autenticada.** A API não aceita mais `role` vindo
   do navegador. A pessoa sempre grava `role=user`; somente Motor/serviço
   gravam `agent`, `analyst` ou `system`.
3. **Nenhuma mensagem pode se perder.** Persistir é anterior a publicar e a
   entregar ao agente. Se o Motor estiver reiniciando, a mensagem fica pendente
   e será conciliada pelo `pump`.
4. **Não há concorrência de runs na mesma sessão.** Uma mensagem humana nunca
   é enviada em paralelo ao run ativo enquanto o Console não oferecer esse
   contrato. Ela é entregue em checkpoint seguro ou após pausa cooperativa.
5. **Pausa preserva trabalho.** Ao pedir conversa, worktree, branch, sessão e
   evidências de validação permanecem disponíveis. A retomada usa a mesma
   sessão da fase/subtarefa; não volta para a análise, salvo escolha explícita
   de “replanejar”.
6. **A mensagem é auditável.** Autor, instante, intenção, fase, subtarefa,
   sessão-alvo e transições de entrega são registrados.

## 4. Modelo de dados proposto

`tarefa_chats` continua sendo o histórico visível. Criar uma migration com as
tabelas abaixo; não sobrecarregar o texto da mensagem com estado operacional.

### 4.1 `tarefa_chat_entregas`

Uma linha por mensagem humana que precisa ser vista pelo Motor.

| Campo | Regra |
|---|---|
| `id` | bigint, PK |
| `tarefa_id` | FK para `tarefas`, obrigatório |
| `mensagem_id` | FK para `tarefa_chats`, único; garante entrega uma única vez |
| `modo` | `normal`, `solicitar_pausa`, `retomar`, `replanejar` |
| `fase_alvo` | `analysis`, `development`, `verification` ou `null` |
| `subtarefa_id` | FK opcional; preenchida quando houver subtarefa ativa |
| `sessao_chave` | chave da sessão escolhida no momento da entrega, opcional até o agente estar disponível |
| `estado` | `pending`, `delivering`, `delivered`, `consumed`, `cancelled`, `failed` |
| `tentativas` | inteiro, padrão 0 |
| `erro` | diagnóstico breve, nulo quando saudável |
| `created_at`, `delivered_at`, `consumed_at`, `updated_at` | auditoria temporal |

Índices obrigatórios: `(tarefa_id, estado, id)`, `(sessao_chave, estado)` e
`UNIQUE(mensagem_id)`.

### 4.2 `tarefa_contextos_execucao`

Uma linha por fase ativa ou suspensa da tarefa. Ela é o vínculo durável que
falta entre chat, subtarefa, worktree e sessão remota.

| Campo | Regra |
|---|---|
| `id` | bigint, PK |
| `tarefa_id`, `subtarefa_id` | tarefa obrigatória; subtarefa opcional para análise |
| `fase` | `analysis` ou `development` |
| `sessao_chave`, `agent_id`, `modelo` | identidade da sessão, obrigatória depois de aberta |
| `worktree_path`, `branch_name` | obrigatórios para desenvolvimento |
| `estado` | `active`, `checkpoint_requested`, `awaiting_human`, `ready_to_resume`, `closed` |
| `last_run_id` | run ativo ou último run concluído |
| `last_checkpoint_at` | instante seguro mais recente |
| `resumo_contexto` | resumo técnico curto: trabalho realizado, próximo passo e riscos |
| `created_at`, `updated_at`, `closed_at` | auditoria |

Restrição lógica: no máximo um contexto `active`, `checkpoint_requested` ou
`awaiting_human` por combinação tarefa/fase/subtarefa. O histórico fechado é
preservado.

Não se replica o histórico textual do Console nessas tabelas: ele continua em
`sessoes_agente`/mensagens da sessão. O novo contexto apenas aponta para ele.

## 5. Máquina de estados

Adicionar o status de tarefa `awaiting_interaction`. Ele é diferente de
`awaiting_clarification`:

- `awaiting_clarification`: o analista ainda não formou plano; a resposta pode
  exigir análise complementar.
- `awaiting_interaction`: já existe trabalho/sessão; a conversa humana deve
  continuar no mesmo contexto e não recriar plano nem subtarefas.

```text
analyzing/running/verifying
  ── mensagem normal ──> permanece no estado; entrega fica pending
  ── checkpoint seguro ──> agente recebe mensagem e responde

analyzing/running/verifying
  ── “Pausar e conversar” ──> checkpoint_requested
  ── run confirma checkpoint ──> awaiting_interaction

awaiting_interaction
  ── mensagem humana ──> agente responde na mesma sessão
  ── “Retomar execução” ──> ready_to_resume → estado anterior
  ── “Replanejar” ──> planned, com confirmação explícita
  ── cancelar ──> cancelled
```

Uma mensagem normal durante execução não altera o status. Ela aparece no chat
imediatamente e recebe o chip **“Será entregue no próximo checkpoint”**. Isso
é honesto e evita interromper um comando, uma migration ou um teste no meio.

## 6. Fluxos exatos

### 6.1 Mensagem normal para tarefa em execução

1. Usuário envia texto na aba Chat.
2. Biblioteca valida permissão e tamanho, grava `tarefa_chats` com `role=user`
   e cria `tarefa_chat_entregas(state=pending, modo=normal)` na mesma
   transação.
3. Biblioteca publica `task.chat.message.created`; o Mapa insere a bolha
   imediatamente por WebSocket.
4. O Motor é avisado por endpoint interno `POST /api/motor/task/:id/chat-pump`
   **após o commit**. Falha nessa chamada não desfaz a mensagem.
5. O `TaskCoordinator` acorda o worker correspondente ou o próximo `pump` lê
   a fila. Se houver run ativo, marca `checkpoint_requested`; se não houver,
   abre a sessão persistida e entrega a mensagem.
6. No checkpoint, o Worker envia ao agente: autor, texto, fase, subtarefa,
   resumo do estado e instrução para responder primeiro no chat e não executar
   ação irreversível sem autorização explícita.
7. A resposta final do agente é gravada em `tarefa_chats(role=agent)`, a
   entrega passa para `consumed` e é publicado `task.chat.message.created`.
8. Se o agente informar que continua trabalhando, o Worker retoma o fluxo; se
   precisar de decisão, entra em `awaiting_interaction`.

### 6.2 Pausar e conversar

1. Usuário seleciona **Pausar e conversar**, opcionalmente com mensagem.
2. A API registra a mensagem/entrega com `modo=solicitar_pausa` e pede ao
   coordenador checkpoint ordenado. Não mata processo nem apaga worktree.
3. O Worker conclui o comando/teste corrente, persiste `resumo_contexto` e
   `last_checkpoint_at`, encerra somente o run, mantém a sessão e libera a vaga
   de execução.
4. Coordenador move a tarefa para `awaiting_interaction` e publica
   `task.interaction.awaiting`.
5. Cada mensagem recebida é enviada à mesma `sessao_chave`; as respostas ficam
   no chat. A tarefa só volta a consumir vaga quando alguém usa **Retomar
   execução**.

### 6.3 Retomar

1. Usuário aciona **Retomar execução**.
2. Coordenador confirma que existe contexto não fechado e worktree acessível.
3. A tarefa volta ao estado que a originou (`analyzing`, `running` ou
   `verifying`) e o Worker abre a mesma `sessao_chave`.
4. A primeira mensagem de retomada inclui o resumo/contexto e todas as
   mensagens `consumed` posteriores ao último checkpoint. Não reenvia a
   descrição inteira, não zera contadores de entrega e não roda análise de
   novo.

### 6.4 Reinício do Motor

No boot e em cada `pump`, o coordenador reconcilia:

- entregas `pending` ou `delivering` sem `consumed`;
- contexto em `checkpoint_requested` sem worker ativo;
- contexto `awaiting_human` com mensagens pendentes;
- sessão/worktree ausente ou inacessível.

Se a sessão tiver se perdido, a tarefa não inventa continuidade: fica
`blocked` com diagnóstico e a opção explícita de retomar em nova sessão,
incluindo no prompt o `resumo_contexto`, o diff e o histórico do chat.

## 7. Alterações por camada

### Banco e schema

- Migration `00xx_task_chat_realtime_execution.sql` com as duas tabelas,
  índices e FKs acima.
- `schema.ts`: declarações Drizzle, enums/tipos, relações e metadados de UI
  somente quando necessários.
- A migration entra no `_journal.json` na mesma entrega.

### Biblioteca/API

- `gerenteagentes.controller.ts`: trocar body público por
  `{ texto: string, modo?: "normal" | "solicitar_pausa" }`; ignorar e rejeitar
  `role` vindo do cliente.
- `gerenteagentes.service.ts`: transação de mensagem + entrega; publicar
  evento apenas depois do commit; chamar o endpoint interno de wake-up sem
  tornar a resposta HTTP dependente dele.
- Novo endpoint interno do Motor: `POST /api/motor/task/:id/chat-pump`.
- Novo endpoint administrativo: `POST /gerenteagentes/tarefas/:id/interacao/retomar`.
- A rota atual `clarification` continua para compatibilidade, mas passa a ser
  uma especialização do mecanismo de entregas, não um caminho paralelo.

### Motor-v2

- `TaskCoordinator`: fila, seleção de contexto, transições
  `checkpoint_requested`/`awaiting_interaction`, reconciliação e liberação de
  recurso quando a conversa espera pessoa.
- `TaskWorker`: checkpoints antes/depois de chamadas remotas, comandos e
  gates; persistência do resumo; consumo da fila; prompt de mensagem humana;
  gravação da resposta do agente no chat.
- `ConsoleAgentRuntimeDriver`: manter o contrato atual para a primeira etapa.
  Para interrupção durante um run longo, acrescentar no Console Developer uma
  operação de pausa cooperativa (`POST /api/chat/runs/:runId/interrupt` ou
  equivalente) e então expor `interruptRun()` no driver. Sem essa operação,
  “Pausar e conversar” só conclui no próximo polling/checkpoint seguro.
- `TaskStateMachine`: novo estado/transições e testes de transição inválida.
- `ExecutionEventBus`/`LibraryRealtimeBroadcaster`: eventos definidos na
  seção 8.

### Mapa de agentes

Sem criar tela nova. Alterar exclusivamente a aba **Chat** do drawer em
`OperationMapScreen.tsx`:

1. Cabeçalho compacto: conexão realtime, fase, subtarefa, modelo e indicador
   **Trabalhando / Checkpoint solicitado / Aguardando você**.
2. Bolhas existentes, mais chips de entrega: `pendente`, `entregue ao agente`,
   `respondido` e `falhou`.
3. Campo de texto preservado; `Enter` envia e `Shift+Enter` quebra linha.
4. Ações ao lado do envio: **Enviar**, **Pausar e conversar** e, quando
   aplicável, **Retomar execução**. Cancelar/deletar continuam nos controles
   já existentes e não migram para o chat.
5. O painel Resumo mostra o último checkpoint: arquivos alterados, testes,
   próximo passo e risco pendente. A aba Execução continua exibindo logs; não
   duplicar logs como mensagens de chat.
6. Quando o WebSocket cair, mostrar “Reconectando”; usar `GET .../chat` apenas
   como recuperação de `replay_unavailable`, não polling de 5 segundos.

## 8. Contrato de eventos realtime

Manter o envelope atual e adicionar tipos explícitos:

| Evento | Emissor | Payload mínimo |
|---|---|---|
| `task.chat.message.created` | Biblioteca/Motor | `id`, `role`, `texto`, `createdAt` |
| `task.chat.delivery.updated` | Motor | `messageId`, `deliveryId`, `state`, `error?` |
| `task.interaction.checkpoint_requested` | Motor | `phase`, `subtaskId?`, `runId?` |
| `task.interaction.awaiting` | Motor | `phase`, `subtaskId?`, `sessionKey`, `summary` |
| `task.interaction.resumed` | Motor | `phase`, `subtaskId?`, `sessionKey` |

O cliente deve continuar aceitando eventos desconhecidos, como faz hoje. A
deduplicação deve usar `eventId` do envelope e `id` da mensagem.

## 9. Segurança e limites

- Texto: mínimo 1, máximo 8.000 caracteres; normalização de espaços e rejeição
  de corpo vazio.
- Autoria: salvar `actor_id`/`actor_name` na entrega e emitir também
  `tarefa_eventos`; o papel visual não é autorização.
- Permissões: leitura segue o escopo do projeto; enviar, pausar e retomar
  requer `admin`, `gerente` ou `operador`; replanejar, commit e deploy exigem
  suas permissões próprias.
- Não expor `sessionKey`, caminho de worktree, token, comandos completos ou
  segredos no texto de chat. O mapa pode receber um identificador mascarado e
  o resumo sanitizado.
- Rate limit por tarefa/autor para evitar centenas de mensagens pendentes;
  mensagens consecutivas pendentes podem ser agrupadas na mesma entrega, sem
  apagar o histórico individual.

## 10. Critérios de aceite e testes

### Primeira entrega (mensagem durável + checkpoint)

- Mensagem aparece no Mapa por WebSocket sem recarregar a página.
- Se Motor estiver indisponível, a mensagem permanece `pending` e é consumida
  após o próximo `pump`.
- Mensagem durante `running` não cria outro run concorrente.
- `Pausar e conversar` preserva worktree e não recria subtarefas.
- `Retomar execução` reutiliza contexto/sessão e não reanalisa a tarefa.
- Reinício entre persistência e entrega não perde nem duplica mensagem.
- Um usuário não consegue publicar `role=agent`.

### Segunda entrega (interrupção cooperativa do Console)

- Interrompe run longo no máximo após o checkpoint declarado pelo runtime.
- Nenhum comando é abortado no meio sem confirmação de segurança do runtime.
- Sessão, diff e chat sobrevivem à interrupção e à retomada.

### Suítes mínimas

- testes unitários da fila e da máquina de estados;
- integração da rota: transação, autorização, idempotência e falha de wake-up;
- `TaskCoordinator` para consumo/reconciliação/restart;
- `TaskWorker` para checkpoint, resumo e retomada;
- `OperationMapScreen` para evento realtime, chips, pausa e retomada;
- typecheck, build, testes completos e `git diff --check`.

## 11. Sequência de implementação recomendada

1. Migration, schema e fila durável de entregas.
2. Endpoint de chat seguro e eventos realtime; adaptar a aba Chat do Mapa.
3. Consumo de mensagens quando não existe run ativo e compatibilidade com
   `awaiting_clarification`.
4. Contexto de execução + checkpoint ordenado + `awaiting_interaction`.
5. Retomada na mesma sessão/worktree e reconciliação pós-restart.
6. Só então, se o Console oferecer suporte, interrupção cooperativa de run.

Cada passo deve ser uma tarefa revisável isoladamente. O primeiro já entrega
confiabilidade e visibilidade; os demais entregam conversa verdadeiramente
interativa sem sacrificar a segurança do Motor.

## 12. Fora de escopo deliberado

- streaming token a token da resposta do modelo;
- anexos, áudio e upload de arquivos;
- mensagens entre projetos diferentes;
- uso do chat para autorizar deploy/commit por texto livre;
- alterações em `compose.yaml`, Gateway ou configuração do OpenClaw.
