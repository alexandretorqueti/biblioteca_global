# Melhorias do Motor — ciclo 2026-10-29 (modo manual supervisionado)

> Contexto: após tarde de incidentes (bloqueios 3456/3457, DLQs com 73 mensagens,
> operador sem controle do monitor), Alexandre determinou em 2026-10-29 19:39:
> **excluir as tarefas criadas no dia (1048–1054, inclusive F1 da Geração Macro),
> desligar motor e monitor, trabalhar UMA melhoria por vez com reporte e novas
> diretrizes a cada passo.** Este documento é a lista de trabalho desse ciclo.
> Estado inicial garantido: `motor.active=false`, `motor.monitor.active=false`
> (verificados no banco), tarefas 1048–1054 excluídas via API canônica
> (cascade confirmou 0 subtarefas restantes; único bloqueio aberto remanescente:
> 3456, da tarefa 1047 — não criada neste ciclo, aguardando diretriz).

## Descobertas do dia (evidências)

- O **monitor-resolvedor JÁ se autocorrigiu duas vezes hoje**: lock órfão de
  worktree (fix `d52d078e`, 16:07 BRT) e correlação duplicada do outbox que
  bloqueou a verificação da 1048/1447 (fix `013c8ef6`, 18:32 BRT) — ambos com
  testes, mergeados e deployados (green boot 21:38 UTC). **Porém não resolveu os
  bloqueios nem retomou as tarefas** → painel continuou mostrando "tudo bloqueado".
- **Não existe rota/botão para desligar o monitor**: `pausarMonitor()` existe no
  service desde sempre, nunca foi exposta no controller nem na UI. O "desliguei
  os dois" do operador não tinha como ter efeito no monitor.
- **DLQs são buraco negro**: commands 48 / test-gates 17 / monitor 8 mensagens
  mortas; único sintoma é `dlq_depth_warning` em log; sem re-enfileiramento,
  sem alerta ao operador. Usuário `motor` do RabbitMQ não tem tag `management`
  (não dá para inspecionar conteúdo).
- **Logs morrem no blue-green**: container blue removido no swap levou o
  histórico das tentativas 1–2 da subtarefa 1447 (auditabilidade perdida).
- `motor_configuracoes.valor` é coluna **JSON** (UPDATE direto exige
  `CAST('false' AS JSON)`) — relevante para operações manuais.
- Portas **trocam no blue-green**: API 3003↔3004, motor 3010↔3011 (checar
  `Ports` via docker socket antes de chamar; UI apontando para porta de
  container morto = toggles que "não funcionam").

## Lista de melhorias (ordem de execução = prioridade combinada)

| # | Melhoria | Status |
|---|---|---|
| 1 | **Controle do operador:** expor `POST /gerenteagentes/motor-monitor/pause|resume` (service já existia) + botões "Pausar/Ativar Monitor" no Mapa de agentes + refletir estado persistido (motor-state) no carregamento do painel | ✅ feita — branch `fix/controle-operador-monitor` (este commit) |
| 2 | **Recovery fecha o ciclo:** o consumidor do monitor faz **ack antes de executar a missão** e o fechamento (veredito → `resolved_at` + `TASK_UNBLOCKED`) depende de o processo viver até o fim; container morto no meio (swap blue-green) = bloqueio órfão para sempre (o `MonitorBlockerReconciler` não reemite porque o `processing_state` consta concluído). Correção: `MonitorMissionRecoveryReconciler` — varredura (boot + 5 min) que detecta missão sem evento terminal antigo + sem execução viva em `motor_active_executions` e reemite o `TASK_BLOCKED` (guarda `inFlight` do consumidor impede duplicata em missão viva; após 3 missões mortas → evento `orphan_exhausted` + alerta humano no chat) | ✅ feita — branch `fix/controle-operador-monitor` (2º commit) |
| 3 | **DlqReconciler + alerta:** boot+periódico (5 min) — drena as 3 DLQs via `visitDeadLetters` (basic.get em canal temporário); classifica contra o estado real do banco (bloqueio aberto / job de gate vivo / tarefa com trabalho ativo) → re-enfileira na origem com contador `dlqRequeueCount` no payload (máx. 2, sem loop) ou arquiva em `motor_dlq_archive` com motivo; erro de infra = devolve e interrompe (nada se perde). Alerta proativo quando profundidade cresce ou cooldown (60 min) vence — Telegram via `TELEGRAM_BOT_TOKEN`+`TELEGRAM_DLQ_CHAT_ID` (sem config = log-only), estado deduplicador em `motor_dlq_alert_state`. Migration `0013_motor_dlq_archive.sql` (dry-run OK) | ✅ feita — branch `fix/controle-operador-monitor` (3º commit) |
| 4 | **Taxonomia de erros (bloqueio é exceção):** erro INFRA do motor (duplicate de outbox, lock, RabbitMQ, DB timeout) = retry transparente com backoff, NÃO consome attempt, NÃO gera bloqueio; AMBIENTE/capacidade = espera; bloqueio+monitor só para problema real de TRABALHO. Princípio do Alexandre (2026-10-29). Implementação: `ErrorTaxonomy.ts` (infra/capacity/work com evidência + cause chain) + `QueueConsumer.deferTransientFailure` (adiamento via outbox, backoff 5s·2^n teto 300s, attempt preservado; após `MOTOR_TRANSIENT_MAX_DEFERS`=40 → DLQ `*-retry-exhausted` SEM bloqueio) + guarda infra no `SubtaskTerminalFailureBlocker`. Doc: `docs/TAXONOMIA-ERROS-MOTOR.md` | ✅ feita — branch `fix/controle-operador-monitor` (4º commit) |
| 5 | **Logs de execução persistentes:** sobreviverem ao swap blue-green (volume/arquivo externo ou dump pré-remoção) — auditoria de tentativas não pode depender da vida do container | pendente |
| 6 | **Infra (ação do Alexandre):** `docker exec motor-rabbitmq rabbitmqctl set_user_tags motor management` — habilita inspeção de DLQs | pendente (operacional) |
| 7 | **Retomada do 1047:** com motor religado, resolver bloqueio 3456 via `external-resolution` (causa raiz já corrigida e deployada em `d52d078e`) e validar em produção os fixes 1 e 2 do dia (lock + outbox) | pendente (aguarda diretriz) |
| 8 | **Geração Macro F1–F5:** recriar tarefas da proposta aprovada (`docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md`) conforme novas diretrizes do Alexandre — as anteriores (1048–1050) foram excluídas | pendente (aguarda diretriz) |
| 9 | **Teardown + piloto Gestão de Tarefas Global:** procedimento desenhado na conversa de 2026-10-29 (dump → tarefas via API → revert do código → drop projeto_8496 → core → agente → worktrees); executar só após religação do fluxo macro | pendente (aguarda diretriz) |

## Regras deste ciclo

- Uma melhoria por vez; reportar antes da próxima; diretriz nova do Alexandre a cada passo.
- Motor e monitor permanecem DESLIGADOS até ordem explícita.
- Trabalho em worktree/branch próprio (nada de commit direto na `base-desenvolvimento`);
  deploy só com autorização.
