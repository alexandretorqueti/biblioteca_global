# Recuperação de sessão do analista — Motor v3

Decisão registrada em 2026-09-23 após a tarefa 866 permanecer em análise
depois de reinícios do Motor.

## Gatilhos

- no boot, antes de iniciar consumidores da fila;
- periodicamente (padrão: 5 minutos), para quedas do Console ou do processo
  que não coincidam com um boot limpo.

## Contrato de recuperação

Uma sessão `analyst_task_sessions.status = active` sem execução viva em
`motor_active_executions` é candidata. Para cada tarefa, apenas a sessão ativa
mais recente pode ser retomada; as anteriores são auditadas como `superseded`.

1. O Motor consulta o estado da própria sessão no Console.
2. Se existir resposta final que atende ao parser de análise, persiste o plano
   normalmente, libera o claim e publica `TASK_READY_FOR_PROGRAMMING` pela
   outbox. Não reanalisa.
3. Se ainda não houver resultado, mantém o claim e envia `[RECOVERY]` na mesma
   `session_key`, pedindo continuidade. O contexto e o histórico permanecem
   os da sessão original.
4. Se o Console reportar falha, a sessão é fechada como `failed` e um evento
   `analysis_recovery_failed` é registrado; não há reprocessamento imediato.

Eventos de auditoria: `analysis_recovery_requested`,
`analysis_recovered_completed`, `analysis_recovered_clarification` e
`analysis_recovery_failed`.

O reconciliador antigo de claims só libera claims que não possuem sessão ativa
recuperável. Isso preserva a exclusividade e impede uma mensagem reentregue de
iniciar uma segunda análise enquanto a recuperação está em andamento.
