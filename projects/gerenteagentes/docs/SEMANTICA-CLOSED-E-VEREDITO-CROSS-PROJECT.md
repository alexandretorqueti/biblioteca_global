# Semântica de `closed` e Veredito Cross-Project do Analista

> Data: 2026-10-31 · Tarefa: `task-p2-1047` · Motor v3
> Incidente motivador: `task-p6-1029` (29/10/2026)
> Relacionados: [INVARIANTE-CONCLUSAO-TAREFAS.md](./INVARIANTE-CONCLUSAO-TAREFAS.md),
> [STATUS-DERIVADO-DE-TAREFAS.md](./STATUS-DERIVADO-DE-TAREFAS.md),
> [VERIFICACAO-DIRETA-ANALISTA.md](./VERIFICACAO-DIRETA-ANALISTA.md),
> [CONTEXTO-ANALISTA.md](./CONTEXTO-ANALISTA.md)

## O incidente motivador (task-p6-1029)

Em 29/10/2026, uma tarefa de verificação no projeto Admin foi analisada e o
analista concluiu com veredito `kind=verification` recomendando criar a tarefa
em OUTRO projeto: *"o problema não é do Admin; é da Biblioteca Global —
packages/ui"*. O que aconteceu:

1. O motor derivou o status `closed` (`terminal_status='completed'` + 0
   subtarefas = estação terminal sem deploy — comportamento correto);
2. O quadro agrupava `closed` junto das canceladas (hoje há estações
   distintas — ver § 1.3);
3. O veredito ficou enterrado em JSON bruto nas `analyst_task_session_messages`
   — **o usuário nunca foi avisado**, apesar de a tarefa pedir explicitamente
   "me avise para eu criar uma tarefa no projeto da biblioteca".

Lacunas da mesma família corrigidas junto: resume de tarefa `closed` era
no-op silencioso com `{ok:true}` enganoso (§ 3) e `TASK_ENQUEUED` era
despachado sem consumidor no v3 (§ 4).

A tarefa `task-p2-1047` entregou: publicação do veredito no chat + notificação,
roteamento cross-project transacional (§ 2), rejeição explícita de resume (§ 3),
consumidor de `TASK_ENQUEUED` (§ 4) e testes de reprodução do caso 1029 (§ 5).

---

## 1. Semântica do status derivado `closed`

Fonte: `motor-v3/src/status/DerivedTaskStatus.ts` (`DerivedTaskStatusResolver`).

### 1.1 Regra canônica: `completed` + 0 subtarefas = `closed`

Quando `task_runtime_facts.terminal_status='completed'` e a tarefa **não tem
subtarefas**, o status derivado é `closed`: a análise concluiu por veredito
direto (verificação), não existe código integrável e **não há deploy** — é uma
estação terminal legítima, distinta de `completed` (que implica integração de
código) e de `cancelled`/`failed`.

A regra é independente do `tipo` da tarefa: no incidente 1029, uma verificação
direta cadastrada como `desenvolvimento` caía no fallback `planned` (tarefa
"zumbi" no quadro). Hoje qualquer tarefa cuja análise termina em
`completed` sem gerar subtarefas vai para `closed`.

### 1.2 `closed` com subtarefas (casos adicionais)

`completedStatus()` também deriva `closed` (e não `completed`) quando a
tarefa tem subtarefas, todas aprovadas (`verified`/`superseded`) com
integração confirmada, e:

- houve **adjudicação administrativa sem deploy** (`deploy_requests` com
  `status='cancelled'` e `last_error LIKE 'Adjudicação administrativa sem
  deploy%'`); ou
- **nenhuma subtarefa integrou código** (`completion_kind='code_change'` ou
  `workspace_status='integrated'`) **e todas** são explicitamente não-código
  (`completion_kind ∈ {analysis, no_code_change, external_operation}`).

Em qualquer outro caso com código integrado → `completed` (segue o fluxo de
deploy normal).

### 1.3 Distinção no quadro (Mapa de agentes)

`closed` **não** é cancelamento. As telas separam as estações:

| Estação | Statuses | Tom | Subtítulo |
|---|---|---|---|
| **Encerradas** | `closed` | success | "finalizadas sem deploy" |
| **Canceladas** | `cancelled`, `aborted` | neutral | "canceladas ou abortadas" |

Fontes: `screens/TaskFlowMap.tsx` (definição de estações ~L192) e
`screens/OperationMapCanvas.tsx` (~L53). O filtro agrupado "Concluídas"
inclui `completed`, `closed` e `deployed` — `closed` nunca cai em
"Canceladas". Comportamento travado por testes
(`screens/__tests__/OperationMapCanvas.stations.test.tsx`,
`screens/__tests__/TaskFlowMap.test.tsx`).

---

## 2. Fluxo do veredito cross-project

Quando a análise conclui com veredito `verification` e o trabalho pertence a
outro projeto, o Motor notifica o usuário e propõe a tarefa no destino — tudo
na **mesma transação** do `persistAnalysis`
(`motor-v3/src/coordinator/MySqlTaskCoordinatorRepository.ts` +
`motor-v3/src/coordinator/VerificationRouting.ts`).

### 2.1 Contrato do analista v13 (campo `routing`)

Migration `0098_analyst_verification_routing.sql`: o veredito `verification`
ganha o campo **opcional** `routing`:

```json
{
  "kind": "verification",
  "verdict": "...",
  "summary": "...",
  "evidence": ["..."],
  "routing": {
    "target_project_slug": "biblioteca-global",
    "recommended_title": "Corrigir renderização do cartão em packages/ui",
    "diagnosis": "O defeito está no componente da Biblioteca Global (packages/ui), não no Admin."
  }
}
```

- `routing.target_project_slug` é **obrigatório quando `routing` está
  presente** (string não vazia); `recommended_title` e `diagnosis` são
  opcionais. Parser: `parseVerificationRouting` em
  `motor-v3/src/analysis/AnalystReply.ts` — `routing` inválido rejeita a
  resposta (não passa silencioso).
- Compatibilidade retroativa: respostas v12 (sem `routing`) continuam
  válidas; os kinds `perguntas`/plano não mudam.
- Os prompts do analista (`analista.primeira_rodada_tarefa` e
  `analista.retomada_apos_clarificacao`, ver `src/prompts/prompt-catalog.ts`)
  instruem explicitamente o uso de `routing` com o exemplo do caso 1029.

### 2.2 Persistência transacional (o que acontece quando há `routing`)

Na transação que grava o fato terminal `completed` da análise:

1. **Chat legível na origem** — mensagem markdown em `tarefa_chats`
   (`insertVerificationChatMessage`) com veredito, resumo, evidências e o
   resultado do roteamento (criada / já existente / destino inválido).
   Substitui o JSON bruto que antes enterrava o veredito. INSERT idempotente
   por marcador `[motor-v3:verification:<taskId>]` (padrão
   `execution/blockerChatAlert.ts`): redelivery não duplica. O marcador nunca
   é truncado (ancora a deduplicação). Realtime (`appendChatMessage`) só é
   emitido quando a mensagem é criada de fato.
2. **Tarefa proposta no projeto de destino** (`applyVerificationRouting`) —
   criada **PAUSADA** (`paused_at=NOW()`, `auto_start=0`, tipo
   `desenvolvimento`), padrão `PostDeployVerifier`: **nunca executa sem ação
   humana**; o usuário revisa e retoma no Mapa de agentes do projeto de
   destino. Descrição contém veredito + resumo + diagnóstico + evidências
   copiadas da origem.
3. **Vínculo de origem bidirecional** em `tarefa_eventos` (ator `motor-v3`,
   origem `motor`): evento `verification_routing` na origem e
   `verification_routing_origin` no destino, com payload cruzando ids/slugs.
4. **Notificação** — além do chat e do realtime: os eventos
   `tarefa_eventos` (`origem='motor'`) alimentam o operational-feed
   (`api/operational-feed.ts`), e a mensagem `TASK_CREATED` no
   `motor_outbox` (status `pending`) aparece como `pending_action` no feed.

### 2.3 Idempotência

- **Tarefa de destino:** `external_id` determinístico
  `task-p<projetoDestinoId>-via-<externalIdOrigem>` (`routedTaskExternalId`;
  sufixo sha256 truncado quando > 64 chars) + `INSERT ... WHERE NOT EXISTS` +
  UNIQUE `tarefas_external_id_unique`. Redelivery da mesma análise retorna
  `status='existing'` — nada é duplicado (o chat informa "já existe
  (redelivery — nada duplicado)").
- **Chat:** marcador de deduplicação (§ 2.2.1).
- **Outbox:** `messageId` determinístico `task-created-<externalId>`
  (`ON DUPLICATE KEY` do `insertOutboxMessage`).

### 2.4 Degradação para slug inválido

Slug de destino inexistente/inativo em `projetos_captados` →
resultado `invalid_target`: **nenhuma tarefa é criada e a análise NÃO falha**.
O chat da origem recebe alerta explícito ("⚠️ Roteamento cross-project NÃO
executado") com o motivo e a ação recomendada (criar manualmente a tarefa no
projeto correto com base no diagnóstico). O usuário sempre fica sabendo — o
roteamento nunca falha em silêncio.

### 2.5 Por que o vínculo NÃO usa `depends_on_task_id`

Decisão documentada (cabeçalho de `VerificationRouting.ts`): dependências são
um gate de execução (`TaskCoordinator.checkDependenciesSatisfied`) — uma
dependência `desenvolvimento` exige deploy succeeded, e a origem fechada por
veredito (`closed`, sem deploy) bloquearia a tarefa roteada **para sempre**.
Além disso, o CRUD de tarefas exige dependências no mesmo projeto (e aqui são
projetos diferentes). O vínculo equivalente em `tarefa_eventos` nas duas
tarefas atende ao requisito de rastreabilidade sem esses efeitos colaterais.

---

## 3. Resume em tarefa terminal (`closed`) — rejeição explícita

Fonte: `motor-v3/src/coordinator/ResumeTerminalGuard.ts` + wiring em
`motor-v3/src/start.ts` e `TaskCoordinator.ts`.

**Antes:** `POST /api/motor/task/:id/resume` despachava
`TASK_RESUME_REQUESTED` para qualquer tarefa e respondia `{ok:true}`; para
tarefa terminal o coordenador só emitia `TASK_IGNORED` — **no-op silencioso**
para o usuário (caso típico: tentar retomar uma `closed`).

**Agora** (espelho do `CancelTerminalGuard` da tarefa 1029):

- **Guarda HTTP síncrono:** o endpoint inspeciona o MESMO fato canônico usado
  pelo coordenador (`task_runtime_facts.terminal_status` + contagem de
  `subtarefas` — `inspectResumeTerminalState`). Se terminal, nenhum comando é
  enfileirado e a resposta é idempotente e estruturada:

  ```json
  {
    "ok": true,
    "accepted": false,
    "alreadyTerminal": true,
    "taskId": "...",
    "terminalStatus": "completed",
    "derivedStatus": "closed",
    "message": "Resume rejeitado: Tarefa encerrada por veredito da análise (completed sem subtarefas → estação terminal \"closed\", sem deploy). Não há execução para retomar; para novo trabalho, crie uma nova tarefa. Nenhum comando foi enfileirado."
  }
  ```

  (`accepted:false` + `alreadyTerminal:true` permitem à Biblioteca distinguir
  "comando enfileirado" de "rejeição explícita" sem interpretar texto — mesmo
  contrato do `buildAlreadyTerminalCancelResponse`.)
- **Caminho durável (mensagem já despachada antes da terminalidade):** no
  `TaskCoordinator`, `TASK_RESUME_REQUESTED` com motivo `task_terminal`/
  `terminal` dispara `announceTerminalResumeRejection` via
  `MySqlResumeRejectionNotifier` (config `resumeRejectionNotifier`).
- **Auditoria:** evento `resume_rejected_terminal` em `tarefa_eventos` +
  mensagem legível no chat da tarefa (marcador idempotente
  `[motor-v3:resume-rejected:<taskId>:<terminalStatus>]`) + realtime em
  melhor-esforço. Falha de auditoria nunca derruba o fluxo principal.
- Mensagens de rejeição específicas por estado: `closed` (encerrada por
  veredito → crie nova tarefa), `completed` (use ajuste/adjustment ou nova
  tarefa), `cancelled`, `failed` e genérica.

---

## 4. Situação do `TASK_ENQUEUED` — consumidor registrado no v3

Fonte: `motor-v3/src/coordinator/TaskEnqueuedConsumer.ts`.

**Antes:** `POST /api/motor/task/:id/enqueue` despachava `TASK_ENQUEUED` sem
consumidor no v3 — lacuna registrada em
[INVARIANTE-CONCLUSAO-TAREFAS.md](./INVARIANTE-CONCLUSAO-TAREFAS.md) ("Fora do
escopo"). O dispatch **não é órfão por acaso**: tem uso real em produção — o
fluxo de setup de projeto da Biblioteca Global
(`projects/gerenteagentes/api/gerenteagentes.service.ts`) cria a tarefa
`setup-<slug>` e chama o endpoint esperando processamento. Sem consumidor, a
tarefa de setup ficava inerte para sempre enquanto a API marcava
`setupStatus='queued'` (no-op silencioso do ponto de vista do usuário).

**Decisão (31/10/2026): registrar consumidor, não remover o dispatch.** O
`TaskEnqueuedConsumer`:

1. audita a entrega (`motor_operation_log` por etapa: received → decision →
   action → completed) e grava evento `task_enqueued` em `tarefa_eventos`
   (alimenta o operational-feed);
2. converte para o caminho canônico do v3: `TASK_RESUME_REQUESTED` via outbox
   durável (`reason='task_enqueued'`), que já possui todas as guardas
   explícitas do `TaskCoordinator` (paused, terminal — inclusive a rejeição do
   § 3 —, plano existente, claim de análise).

Idempotência: a ponte é pulada se já existe `TASK_RESUME_REQUESTED` pendente
no `motor_outbox` para a mesma tarefa (padrão `TaskExecutionReconciler`);
duplicatas que escapem caem nas guardas do coordenador — nunca iniciam duas
análises. Falha na inserção do outbox propaga para o `QueueConsumer`
(retry/DLQ): a ponte é o efeito durável e não pode ser perdida em silêncio.
Falha de auditoria em `tarefa_eventos` não derruba o consumo.

**Regra de projeto reforçada:** nenhuma mensagem de comando pode ser
despachada sem consumidor.

---

## 5. Testes (evidência)

| Arquivo | Cobre |
|---|---|
| `motor-v3/test/analyst-reply-routing.test.ts` | Parse do contrato v13: `routing` opcional, slug obrigatório quando presente, rejeições |
| `motor-v3/test/verification-routing.test.ts` | Roteamento transacional: criação pausada, external_id determinístico, idempotência (`existing`), eventos de vínculo, outbox `TASK_CREATED`, degradação `invalid_target` |
| `motor-v3/test/resume-terminal-guard.test.ts` | Resposta `alreadyTerminal`, derivação `closed`, mensagens por estado terminal |
| `motor-v3/test/task-coordinator.test.ts` | Rejeição explícita no caminho durável (`resumeRejectionNotifier`) |
| `motor-v3/test/task-enqueued-consumer.test.ts` | Ponte para `TASK_RESUME_REQUESTED`, idempotência, auditoria, DLQ |
| `motor-v3/test/dispatch-consumer-contract.test.ts` | Contrato estático: todo comando despachado tem consumidor |
| `motor-v3/test/case-1029-cross-project-verdict.test.ts` | **Reprodução ponta a ponta do incidente 1029:** parse v13 → `persistAnalysis` → chat suprido + notificação + tarefa pausada no destino + status derivado `closed` |
| `screens/__tests__/OperationMapCanvas.stations.test.tsx`, `screens/__tests__/TaskFlowMap.test.tsx` | `closed` na estação "Encerradas", nunca em "Canceladas" |

Execução: `npx vitest run <arquivos>` em `projects/gerenteagentes/motor-v3`
(45 testes verdes nos 5 arquivos do fluxo, 31/10/2026).
