# Runbook: runtime sem resposta verificável

## Regra operacional

`subtarefas.deliver_count` é o contador único e o orçamento é global por
subtarefa. O limite efetivo é `maxRework + 1` (mínimo 1), somando todas as
tentativas de todos os modelos da cadeia. Isso inclui:

- resposta final vazia, malformada ou sentinel de falha;
- sessão que falha antes de responder;
- modelo indisponível;
- recuperação de sessão e reexecução após falha.

O loop do worker consulta esse orçamento antes de iniciar cada entrega. A
escada de modelos não multiplica o limite. Ao atingir o limite, a subtarefa é
marcada como `blocked`, com diagnóstico terminal e bloqueio
`no_reply_exhausted`; nenhum novo `pump` deve reenfileirá-la.

## Fluxo esperado

1. Incrementar `deliver_count` antes de criar a sessão/worktree da entrega.
2. Registrar `delivery_started`.
3. Se não houver resposta verificável, persistir classificação, fingerprint e
   evento append-only.
4. Se ainda houver orçamento, marcar `pending` com `next_retry_at` futuro.
5. Se o orçamento acabou, marcar `blocked` e limpar `next_retry_at`.

Falhas remotas transitórias que chegam ao coordenador por `onTaskFailed`
seguem a mesma política em `handleRuntimeFailureRetry`. O cleanup não deve
zerar `next_retry_at` de uma subtarefa `pending` antes de o retry vencer.

## Diagnóstico de incidente

Para um caso como `Modelo indisponível: <modelo>`:

- confirmar `deliver_count`, `max_rework`, `status` e `next_retry_at`;
- confirmar no histórico que cada entrega tem `delivery_started` e o evento de
  falha correspondente;
- confirmar que o número de entregas não excede `computeEffectiveRetryLimit`;
- confirmar que, ao atingir o limite, existe `failure_diagnostic` e um
  bloqueio `no_reply_exhausted`.

Não corrigir esse caso aumentando a quantidade de modelos ou resetando
`deliver_count`. Corrigir o catálogo/provedor indisponível separadamente e
retomar a subtarefa somente após intervenção autorizada.
