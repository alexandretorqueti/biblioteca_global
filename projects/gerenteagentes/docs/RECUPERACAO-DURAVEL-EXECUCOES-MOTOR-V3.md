# Recuperação durável de execuções no Motor-v3

## Decisão

O boot do Motor deve reconciliar trabalho interrompido sem assumir que a mensagem RabbitMQ ainda representa todo o estado da execução.

- Análises continuam sendo recuperadas por `AnalysisSessionRecoveryReconciler`.
- Execuções DEV passam a persistir sessão, execução, modelo, baseline e worktree antes de aguardar o Console.
- Uma sessão DEV ativa é consultada novamente após restart. Se ainda estiver executando, permanece ativa e será consultada no próximo ciclo. Se terminou, o Motor valida Git e gates e volta ao fluxo normal. Se a sessão remota desapareceu ou falhou, o contexto é encerrado e a mesma subtarefa é reenfileirada de forma idempotente, preservando o worktree.
- `motor_operation_log` permanece trilha de auditoria; o estado recuperável vem de `motor_agent_sessions`, `tarefa_contextos_execucao`, `subtarefas` e `test_runs`.

## Invariantes

1. Uma sessão persistida antes do primeiro envio pode ser reassociada depois do restart.
2. O reconciliador nunca cria uma segunda sessão enquanto a persistida está ativa.
3. Apenas uma recuperação por sessão roda no processo (`inFlight`).
4. Finalização e reenfileiramento são condicionais ao estado `running`, portanto repetição do ciclo não duplica transições.
5. Falha de auditoria não pode impedir a transição durável da subtarefa.

