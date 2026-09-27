# Recuperação durável de execuções no Motor-v3

## Decisão

O boot do Motor deve reconciliar trabalho interrompido sem assumir que a mensagem RabbitMQ ainda representa todo o estado da execução.

- Análises continuam sendo recuperadas por `AnalysisSessionRecoveryReconciler`.
- Execuções DEV passam a persistir sessão, execução, modelo, baseline e worktree antes de aguardar o Console.
- Uma sessão DEV ativa é consultada novamente após restart. Se ainda estiver executando, permanece ativa e será consultada no próximo ciclo. Se terminou, o Motor valida Git e gates e volta ao fluxo normal. Se a sessão remota desapareceu ou falhou, o contexto é encerrado e a mesma subtarefa é reenfileirada de forma idempotente, preservando o worktree.
- Timeout local do worker não é evidência de falha remota: para DEV, a sessão persistida é entregue ao reconciliador e a mensagem RabbitMQ pode ser confirmada sem encerrar a subtarefa. O reconciliador continua usando a mesma sessão.
- Falhas legadas com a assinatura `Timeout global do worker`, sessão persistida ativa e resposta remota válida são reabertas atomicamente; o evento de falha pendente é suprimido antes de retornar a subtarefa para `running`.
- O reconciliador identifica repetição consecutiva de chamadas de ferramenta. Ao atingir o limiar, tenta abortar o run físico antes de reenfileirar; se não conseguir, registra atenção e preserva a sessão. A telemetria guarda somente o hash da ação.
- `motor_operation_log` permanece trilha de auditoria; o estado recuperável vem de `motor_agent_sessions`, `tarefa_contextos_execucao`, `subtarefas` e `test_runs`.

## Invariantes

1. Uma sessão persistida antes do primeiro envio pode ser reassociada depois do restart.
2. O reconciliador nunca cria uma segunda sessão enquanto a persistida está ativa.
3. Apenas uma recuperação por sessão roda no processo (`inFlight`).
4. Finalização e reenfileiramento são condicionais ao estado `running`, portanto repetição do ciclo não duplica transições.
5. Falha de auditoria não pode impedir a transição durável da subtarefa.
6. Uma subtarefa só é reenfileirada após loop quando o run remoto foi abortado com sucesso.

## Parâmetros operacionais

- RabbitMQ: policy `motor-consumer-timeout-90m` nas filas `^motor\.` com `consumer-timeout=5400000` (90 minutos).
- DEV: `MOTOR_WORKER_TIMEOUT_MS=4800000` e `MOTOR_WORKER_GLOBAL_TIMEOUT_MS=5100000`.
- Entrega: `MOTOR_RABBITMQ_CONSUMER_TIMEOUT_MS=5400000` e `MOTOR_RABBITMQ_ACK_SAFETY_MS=300000`; baseline e preparação consomem o mesmo orçamento.
- Loop: `MOTOR_DEVELOPMENT_LOOP_REPEAT_THRESHOLD=5`.
