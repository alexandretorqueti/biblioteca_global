# Analista interativo — clarificação por chat (tarefa e projeto)

> Status: **IMPLEMENTADO** em `feature/analista-interativo-chat` (2026-09-01),
> a partir de `base-desenvolvimento`. Substitui/atualiza a especificação
> histórica `ESPECIFICACAO_ANALISTA_INTERATIVO_CHAT.md` (repositório legado).

## 1. Objetivo

Quando o analista (etapa de análise do motor) encontra **ambiguidade** na
definição de uma tarefa, ele **pergunta em vez de inventar um plano ruim**.
As perguntas e respostas ficam registradas no **CHAT DA TAREFA** (tabela
`tarefa_chats`, mesma tela já existente) e o analista retoma a análise com o
histórico quando a resposta chega. O mesmo mecanismo vale para o **chat do
projeto** (`projeto_chats`).

## 2. Decisões confirmadas pelo Alexandre (2026-09-01)

| # | Decisão |
|---|---------|
| 1 | Notificação via canal Telegram: aprovada (ajuda na automação futura); por ora o evento `clarifying` sai pelo barramento de atividades/realtime |
| 2 | Respostas numeradas (`1: x; 2: y`) suportadas — o analista é instruído a aceitá-las |
| 3 | `resumo` (entendimento atual) é obrigatório na pergunta do analista |
| 4 | **Sem limite de turnos**: o analista pergunta sempre que precisar; melhor perguntar do que fazer errado |
| 5 | O detail da tarefa expõe a clarificação pendente (mensagem + desde quando) |
| 6 | A conversa fica registrada no CHAT DA TAREFA existente (`tarefa_chats`) e no chat do projeto (`projeto_chats`) — sem tabela nova |
| 7 | Retomada confirmada: a análise reenviada aparece no fluxo normal de atividades |
| 8 | Idempotência: quem já gravou a mensagem chama o motor com `jaPersistida: true` |
| 9 | **Quem responde é o agente DO PROJETO** (1 projeto = 1 agente) ou o Alexandre — não é fixamente o GerenteAgentes |
| 10 | Perguntas tendem a decisórias ("prefere A ou B?"), mas perguntas abertas são permitidas |

## 3. Fluxo por tarefa

```
planned ──(pump: análise)──▶ analyzing
analyzing ──(analista devolve perguntas)──▶ awaiting_clarification   [worker encerra; timeout para de contar]
awaiting_clarification ──(resposta no chat)──▶ planned               [pump reenvia para análise com o histórico]
analyzing ──(analista devolve plano)──▶ ready                        [subtarefas criadas]
```

- O **timeout nunca estoura durante a espera**: o worker encerra ao pedir
  clarificação (não há relógio correndo) e o `ExpirationReconciler` só toca
  tarefas `analyzing`/`running` — a tarefa pode ficar dias aguardando.
- **Boot/crash**: `awaiting_clarification` não é re-enfileirada como órfã;
  fica intacta até a resposta chegar.
- A cada nova rodada de análise, o histórico `analyst`/`user` do chat é
  reinjetado no prompt do analista (sessões de análise são efêmeras por
  modelo/tentativa — o banco é a memória da conversa).

### Contrato de resposta do analista

```jsonc
// Forma 1 — definição clara:
{ "subtarefas": [ { "seq": 1, "titulo": "...", "scope": "...", "acceptance_criteria": ["..."] } ] }

// Forma 2 — ambiguidade (resumo obrigatório, máx. 8 perguntas/turno):
{ "kind": "perguntas", "resumo": "o que já entendeu", "perguntas": ["prefere A ou B?", "..."] }
```

Parse tolerante: aceita `kind` explícito ou apenas a presença do array
`perguntas`; aceita cerca de código ao redor do JSON.

### Papéis no chat

- `analyst` — pergunta do analista (mensagem única: entendimento + perguntas numeradas)
- `user` — resposta do Alexandre ou do agente do projeto

## 4. Endpoints

### Motor (porta 3010, mesmo container da biblioteca)

- `POST /api/motor/task/:id/clarification`
  Body: `{ "texto": string, "jaPersistida"?: boolean }`
  Grava a resposta no chat (salvo `jaPersistida: true`), valida que a tarefa
  está em `awaiting_clarification`, devolve para `planned` e aciona o pump.
- `GET /api/motor/task/:id` agora inclui
  `clarificacaoPendente: { message, askedAt } | null` quando aplicável.

### Biblioteca (rotas existentes/novas)

- `POST /api/gerenteagentes/tarefas/:id/chat` — rota existente do CHAT DA
  TAREFA: quando `role=user` e a tarefa está `awaiting_clarification`,
  encaminha a resposta ao motor (`jaPersistida: true`) para retomar a análise.
- `POST /api/gerenteagentes/projetos-captados/:id/clarificacao` (NOVA) —
  o analista registra perguntas no chat do projeto:
  Body: `{ "resumo": string, "perguntas": string[] }` → grava mensagem
  `analyst` e marca a geração corrente como `awaiting_clarification`.
- `POST /api/gerenteagentes/projetos-captados/:id/chat` — quando `role=user`
  e a geração mais recente está `awaiting_clarification`, devolve a geração
  para `pending` (retomada).

## 5. Código

### Motor (`projects/gerenteagentes/motor-v3`)

- `src/shared/types/index.ts` — status novo `awaiting_clarification`.
- `src/policies/TaskStateMachine.ts` — transições `await_clarification`
  (`analyzing → awaiting_clarification`) e `clarification_answered`
  (`awaiting_clarification → planned`); `fail`/`cancel` aceitam o estado.
- `src/planning/ClarificationStore.ts` (NOVO) — persistência/formatação para
  tarefa (`tarefa_chats`) e projeto (`projeto_chats`).
- `src/planning/AnalystReply.ts` (NOVO) — contrato de resposta com
  clarificação (parse tolerante).
- `src/workers/TaskWorker.ts` — prompt do analista com as duas formas +
  histórico; `phaseAnalyze` persiste perguntas e emite `clarifying`;
  `sendClarifying` encerra o worker sem falha.
- `src/workers/WorkerProtocol.ts` — mensagem `clarifying`.
- `src/coordinator/TaskCoordinator.ts` — `onTaskClarifying` (transição +
  atividade), `answerClarification` (resposta + retomada),
  `clarificacaoPendente` no detail.
- `src/api/MotorAPI.ts` — endpoint `clarification` + leitura de body.
- `src/events/ExecutionEventBus.ts` — tipos `clarifying` (e `deployed`, que
  estava fora do union e quebrava o build na base).

### Biblioteca (`projects/gerenteagentes`)

- `api/gerenteagentes.service.ts` — encaminhamento da resposta ao motor;
  `registrarClarificacaoProjeto`; retomada da geração via chat do projeto.
- `api/gerenteagentes.controller.ts` — rota `.../clarificacao`.
- `schema.ts` — comentário do status de `geracoes_projeto` inclui
  `awaiting_clarification` (coluna varchar já comporta).

### Testes

- `motor-v3/test/AnalystReply.test.ts` (9 casos)
- `motor-v3/test/ClarificationStore.test.ts` (6 casos)
- `motor-v3/test/TaskStateMachine.test.ts` (+6 casos de clarificação)

## 6. Pontos futuros (fora desta entrega)

- Entrega de notificação **Telegram** de fato (hoje o evento `clarifying` sai
  pelo barramento/realtime; o disparo para o canal entra com a automação).
- Consumo da clarificação **por projeto**: o executor da geração de tarefas
  macro (analista forte) ainda não existe no motor — os endpoints e o
  status estão prontos para ele (`registrarClarificacaoProjeto` + geração em
  `awaiting_clarification`).
- Autoria fina da resposta (registrar qual agente respondeu): hoje a resposta
  entra como `role=user`; a identificação do agente atende via chat do
  próprio projeto.

## 7. Clarificação incremental — checkpoint e retomada na mesma sessão (task-p2-1040, 2026-10)

> Substitui o comportamento da seção 3 em que "a cada nova rodada de análise o
> histórico é reinjetado e a análise recomeça do zero". Desde a task-p2-1040 a
> retomada após clarificação é **incremental**: continua na mesma sessão do
> analista, sem reenviar a investigação integral (incidente da tarefa 1022:
> três análises completas para duas respostas de esclarecimento).

### Checkpoint de clarificação (`analysis_clarification_checkpoints`, migration 0094)

- Quando o analista devolve `kind="perguntas"`, o `persistAnalysis` grava na
  mesma transação: chat (`tarefa_chats`, append-only), `clarification_pending_at`
  e um **checkpoint** com `session_key`/`runtime_session_id`/`model`,
  `analysis_execution_id` (execução que perguntou), `round_number`, perguntas,
  resumo e evidências (quando houver).
- A sessão do analista em `analyst_task_sessions` passa a
  `status='awaiting_clarification'` (não é mais `completed`) — o reconciliador
  de órfãs só trata `status='active'`, portanto a sessão aguarda intacta até a
  resposta, inclusive sobrevive a restart do Motor.
- Tabela **append-only**: rodadas antigas transitam para `superseded` (nova
  rodada, plano concluído, verificação ou cancelamento) ou `consumed`
  (resposta processada pela retomada). Nada é apagado.

### Retomada (resposta no chat)

1. `adicionarMensagemChatTarefa` grava a resposta, limpa
   `clarification_pending_at` e enfileira `TASK_RESUME_REQUESTED`
   (`reason='clarification_response'`, `chatMessageId`). A **entrega direta**
   na sessão (`entregarMensagemAoAnalista`) é **ignorada** quando há
   checkpoint pendente (entrega marcada `cancelled`) — o Motor é o dono da
   retomada, evitando duas continuações concorrentes na mesma sessão.
2. `TaskCoordinator` faz o claim normal de análise (novo `executionId`) e,
   sendo `clarification_response`, localiza o checkpoint `awaiting_response`
   mais recente e o **reivindica com fencing** (`claimClarificationCheckpoint`
   grava `resume_execution_id` + `answer_chat_message_id`; `FOR UPDATE`;
   `answered` é re-reivindicável para cobrir retry/restart).
3. `ConsoleAnalystRunner.resumeClarification` continua **na mesma sessão**
   (`runtime_session_id` do checkpoint): sem `createSession`, sem blocos de
   descrição. Envia somente o prompt de retomada
   (`analista.retomada_apos_clarificacao`, nova versão na migration 0094) com
   referência compacta da descrição, histórico do chat e a resposta do
   usuário, instruindo: *não reiniciar a investigação e não repetir perguntas
   já respondidas, salvo justificativa explícita no resumo*.
4. Sucesso → `consumeClarificationCheckpoint` (fencing por
   `resume_execution_id`) → `persistAnalysis` normal. Novas perguntas geram
   **rodada 2** do checkpoint na mesma sessão. Plano/verificação superam
   checkpoints pendentes.
5. Sem checkpoint válido (inexistente, sem sessão vinculada ou conflito de
   reivindicação) → fallback na análise completa anterior, **com
   justificativa auditada** em `tarefa_eventos`
   (`analysis_clarification_checkpoint_missing` /
   `analysis_clarification_checkpoint_unusable` /
   `analysis_clarification_resume_conflict`). Retomada efetiva registra
   `analysis_clarification_resumed` com `checkpointId`, `roundNumber`,
   `sessionKey`, `runtimeSessionId`, `analysisExecutionId` e
   `answerChatMessageId`.

### Restart do Motor

- **Entre pergunta e resposta:** checkpoint e sessão ficam no banco
  (`awaiting_response` / `awaiting_clarification`); a resposta posterior
  encontra o checkpoint e retoma com fencing — coberto por teste.
- **Durante a retomada:** `onSessionResumed` religa a sessão ao
  `analysis_execution_id` vigente (`status='active'`) e o
  `AnalysisSessionRecoveryReconciler` recupera pelo caminho já existente.
- Perguntas recuperadas pelo reconciliador (`complete()` com
  `kind='questions'`) também mantêm a sessão em `awaiting_clarification`.

### Auditoria

Cadeia consultável: `tarefa_chats` (perguntas/respostas) ↔
`analysis_clarification_checkpoints` (rodada, sessões, executions de análise e
retomada, mensagem de resposta) ↔ `analyst_task_sessions` /
`analyst_task_session_messages` (transcript append-only, `message_key`
`<attemptId>:clarification:<seq>`) ↔ `prompts_execucoes` (prompt de retomada
composto) ↔ `tarefa_eventos` (eventos acima).

### Código (task-p2-1040)

- `motor-v3/src/coordinator/ClarificationCheckpoints.ts` — tipos + helpers SQL.
- `motor-v3/src/coordinator/TaskCoordinator.ts` — `prepareClarificationResume`,
  config `checkpoints`, consume pós-retomada.
- `motor-v3/src/coordinator/MySqlTaskCoordinatorRepository.ts` —
  `ClarificationCheckpointStore` + persistAnalysis (supersede/insert).
- `motor-v3/src/analysis/ConsoleAnalystRunner.ts` — `resumeClarification`,
  `onClarificationCheckpoint`, `announceOutcome`.
- `motor-v3/src/analysis/PromptChunking.ts` — builders da continuação.
- `motor-v3/src/coordinator/AnalysisSessionRecoveryReconciler.ts` — perguntas
  recuperadas mantêm sessão aberta.
- `motor-v3/src/coordinator/TaskCancelConsumer.ts` — cancelamento supercede
  checkpoints e fecha sessões em espera.
- `motor-v3/src/start.ts` — wiring (`checkpoints`, `onClarificationCheckpoint`,
  `onSessionResumed` com religação de execução).
- `migrations/0094_analysis_clarification_checkpoints.sql` — tabela + nova
  versão do prompt de retomada.
- `api/gerenteagentes.service.ts` — skip da entrega direta com checkpoint
  pendente.
- Testes: `motor-v3/test/analysis-clarification-resume.test.ts`,
  `motor-v3/test/clarification-checkpoint-repository.test.ts`,
  `motor-v3/test/analysis-session-recovery-reconciler.test.ts` (+1),
  `motor-v3/test/managed-analysis-prompt-resolver.test.ts` (+1),
  `api/__tests__/gerenteagentes.service.clarification-checkpoint.spec.ts`.
