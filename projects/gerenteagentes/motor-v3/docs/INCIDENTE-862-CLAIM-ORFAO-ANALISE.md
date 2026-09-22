# Incidente 862 — claim de análise órfão congela tarefa em "analyzing"

**Data:** 2026-09-22
**Tarefa:** `task-p6-862` (projeto 6 — Administrador Global)
**Sintoma relatado:** exclusão rejeitada com 400 `Tarefa task-p6-862 ainda está em execução; cancele antes de excluir`; cancelamento via API retornava `{ok:true}` sem efeito; status derivado preso em `analyzing` sem worker ativo.

## Linha do tempo (evidências: `motor_message_processing_state`, `motor_operation_log`, `task_runtime_facts`)

| Hora (UTC) | Fato |
|------|------|
| 13:08:05 | `TASK_CREATED` processada. |
| 13:08:10 | `TASK_RESUME_REQUESTED` (msg `fe676eaa…`): claim atômico OK (`claim_analysis_atomic`), `emit_analysis_selected` OK — **sem seq. 6 (`start_analyst`)**: o processo do Motor (slot blue) morreu durante a análise. |
| ~13:08→14:15 | Blue unhealthy; motor na porta 3010 sem responder. |
| 14:16:40 | Boot do green: `OutboxPublisher.recoverAbandonedProcessing` republicou a mensagem ("Recuperada após reinício do Motor"). Reprocessamento **rejeitado pela política P03 com `analysis_already_claimed`** → mensagem acked como "completed" → nenhum retry posterior. Claim órfão permanente. |
| 14:50:49 / 14:56:01 | Dois `TASK_CANCEL_REQUESTED` marcados "completed" **sem nenhuma operação executada** (não há consumidor). |
| ~14:56 | Intervenção manual: `terminal_status='cancelled'` gravado à mão; exclusão então funcionou. |

## Causas raiz (motor-v3, produção)

### Bug A — recuperação de claim órfão era código morto (ordenação)

`TaskCoordinator.handle` possuía ramo para reentrega da mesma mensagem
(`analysisExecutionId.includes(messageId)` → `releaseAnalysisClaim`), mas o gate
de políticas (`CommandPolicyResolver` com P03/`analysis_not_claimed`) rodava
**antes** e rejeitava a mensagem reentregue com `analysis_already_claimed`. O
ramo nunca era alcançado; a mensagem era confirmada e o claim ficava órfão para
sempre → `DerivedTaskStatus` retorna `analyzing` (analysis_started_at preenchido
+ zero subtarefas) → `DELETE /api/motor/task/:id` bloqueia.

### Bug B — nenhuma reconciliação de claims órfãos no boot

A recuperação dependia exclusivamente da reentrega da mensagem original. Quando
a mensagem já foi consumida ("completed"), foi para DLQ, ou a fila não
reentrega, nada liberava o claim. Não havia reconciliação no boot.

### Bugs correlatos descobertos na auditoria (NÃO corrigidos neste ciclo — apenas documentados)

1. **`TASK_CANCEL_REQUESTED` não tem consumidor.** O catálogo (`motor_commands`) só registra C03 (RESUME) e C10–C13 (deploy). O cancel enfileira comando que nenhum consumer trata; `QueueConsumer` marca "completed" (handlers no-op não lançam erro) e a API responde `{ok:true}` — sucesso falso. A Biblioteca ainda grava `cancelled` em `tarefa_eventos` confiando nesse ok (trilha de auditoria inconsistente com os fatos).
2. **Falha de análise não vai para "Atenção".** O catch do coordenador faz `releaseAnalysisClaim` + `bus.emit('ANALYSIS_FAILED')` + rethrow (DLQ após 3 tentativas), mas: nenhum subscritor para `ANALYSIS_FAILED`; motor-v3 nunca escreve `terminal_status='failed'` (só `'completed'` no `DevelopmentExecutionRepository`); nenhum `INSERT INTO bloqueios` no caminho de análise; nenhum evento do catálogo (E33_TASK_BLOCKED) emitido; nada em `tarefa_eventos`. A tarefa volta silenciosamente a `planned` (ou congela órfã) sem aparecer na estação Atenção.
3. **`TASK_PAUSE_REQUESTED` sem consumidor.** A pausa "funciona" porque a Biblioteca grava `paused_at` direto no banco (`gerenteagentes.service.ts`), mas nenhum worker em execução é parado.
4. **`tarefa_eventos` não é escrito pelo motor-v3** (0 referências no src) — trilha de auditoria só tem ações de usuário da Biblioteca.
5. **Comandos zumbis:** `TASK_CREATED`, `TASK_ENQUEUED`, `PUMP_TRIGGERED` são despachados e ackados sem efeito — poluem outbox/fila e mascaram o bug 1 (tudo parece "completed").
6. **Contrato desonesto:** cancel/pause assíncronos deveriam responder `202 accepted` (como o endpoint de deploy result), não `200 {ok:true}`.

> Observação: o motor-v2 possui bug análogo (`saveTaskTransition` case `"fail"` não chama `facts.record(taskId, "failed")`), mas o v2 não está em produção (MOTOR_VERSION=v3) — não foi causa deste incidente.

## Correções implementadas neste ciclo (somente itens 3+4 da auditoria, aprovados por Alexandre em 2026-09-22)

### Correção A — ordem no `TaskCoordinator.handle`

A recuperação de claim órfão (mesma `messageId` contida no `analysis_execution_id`)
agora roda **antes** do gate de políticas, com trilha auditável no
`motor_operation_log` (primitiva `release_orphan_analysis_claim`). Sequências do
operation log agora usam contador único por operação (antes havia colisão de
números entre ramos).

### Correção B — `AnalysisClaimReconciler` no boot

Novo módulo `src/coordinator/AnalysisClaimReconciler.ts`, executado no `start.ts`
**antes** do `QueueConsumer.start()`: sob a premissa de instância única
(`docs/CONCORRENCIA-E-LOCKS-MOTOR.md`), no boot não há análise viva — qualquer
`task_runtime_facts.analysis_started_at` remanescente é órfão e é liberado
(idempotente, UPDATE condicionado). Cada liberação é logada no console com
tarefa/execution/início. Se a mensagem original for reentregue depois, o claim
atômico é refeito sem duplicação.

## Validação

- Novos testes: `test/task-coordinator.test.ts` (+3 casos: liberação antes do gate com políticas ativas, primitiva no operation log com sequências únicas, rejeição mantida para claim de outra execução) e `test/analysis-claim-reconciler.test.ts` (2 casos: liberação com trilha, no-op sem claims).
- Suíte motor-v3: **187/187 testes (31 arquivos)** + `tsc --noEmit` limpo.

## Pendências para próximos ciclos (backlog da auditoria)

- [ ] Consumidor + catálogo para `TASK_CANCEL_REQUESTED` (C04: policy "cancelar se não terminal" + ação com primitivas `release_analysis_claim`, `mark_terminal_cancelled`, `resolve_blockers`).
- [ ] Handler de `ANALYSIS_FAILED`: gravar `bloqueios` (→ derivado `blocked` = Atenção), emitir E33, registrar `tarefa_eventos` e operation log.
- [ ] Consumidor de `TASK_PAUSE_REQUESTED` (parada graciosa de worker ativo; A07 já existe no catálogo sem uso).
- [ ] Motor-v3 escrever `tarefa_eventos` nos eventos operacionais.
- [ ] Cancel/pause retornarem `202 accepted`; Biblioteca só registrar evento após fato persistido.
- [ ] Remover ou implementar consumidores de `TASK_CREATED`/`TASK_ENQUEUED`/`PUMP_TRIGGERED`.
- [ ] (motor-v2, legado) `saveTaskTransition` case `"fail"` chamar `facts.record(taskId, "failed")`.
