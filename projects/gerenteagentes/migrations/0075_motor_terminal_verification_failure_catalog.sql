-- Catálogo revisável de falhas operacionais do Motor v3.
--
-- OBJETIVO
--   Tornar explícitas, nas tabelas já existentes, as famílias de erro que hoje
--   são decididas em código. O catálogo passa a ser a fonte da decisão quando o
--   TerminalFailureHandler/roteador for conectado ao EventClassifier e ao
--   ActionExecutor.
--
-- LIMITES DESTA MIGRATION
--   1. Não muda o comportamento do runtime por si só.
--   2. Eventos/padrões são cadastrados ativos para permitir classificação.
--   3. Ações e reações novas ficam INATIVAS até o handler transacional existir.
--      Ativá-las antes disso produziria uma falsa sensação de recuperação.
--   4. O inventário cobre falhas operacionais assíncronas do pipeline. Erros de
--      validação síncrona da API (BadRequest/NotFound) permanecem fora daqui.
--   5. Comentários usam `--`: `//` não é comentário SQL MySQL portátil.
--
-- LEGENDA
--   [JÁ TRATADO NO CÓDIGO] decisão hardcoded existente.
--   [PRECISA DECIDIR O CAMINHO] política ainda não aprovada.
--   [LACUNA] não há fechamento de estado de negócio confiável.
--
-- IMPORTANTE
--   O catálogo escolhe somente ações fechadas e conhecidas. Nunca deve conter
--   SQL, shell ou código arbitrário fornecido por registro de banco.

-- ---------------------------------------------------------------------------
-- 1. EVENTOS: inventário das famílias de falha operacional
-- ---------------------------------------------------------------------------

INSERT INTO `motor_events`
  (`code`, `name`, `category`, `scope`, `priority`, `active`)
VALUES
  -- [LACUNA] Caso da tarefa 899. Hoje a mensagem morre na DLQ e a subtarefa
  -- permanece `verifying`.
  ('E36_VERIFICATION_TERMINAL_FAILURE', 'Falha terminal na verificação da subtarefa', 'erro', 'subtarefa', 20, 1),

  -- [JÁ TRATADO NO CÓDIGO] QueueConsumer envia diretamente para DLQ.
  -- Caminhos possíveis: a) DLQ + ocorrência global; b) DLQ + alerta; c) rejeitar
  -- definitivamente e impedir nova entrega do mesmo messageId.
  ('E37_QUEUE_INVALID_MESSAGE', 'Envelope de mensagem inválido', 'infra', 'global', 10, 1),

  -- [JÁ TRATADO NO CÓDIGO] QueueConsumer envia diretamente para DLQ.
  -- Caminhos possíveis: a) recuperar claim expirado; b) DLQ + alerta; c) bloquear
  -- o agregado quando taskId/subtaskId forem identificáveis.
  ('E38_QUEUE_UNEXPECTED_PROCESSING_STATE', 'Estado inesperado no processamento da fila', 'infra', 'global', 11, 1),

  -- [JÁ TRATADO NO CÓDIGO] TaskCoordinator + AnalysisFailureBlocker bloqueiam a
  -- tarefa na tentativa final e publicam TASK_BLOCKED via outbox.
  ('E39_ANALYSIS_TERMINAL_FAILURE', 'Falha terminal da análise', 'erro', 'tarefa', 21, 1),

  -- [JÁ TRATADO NO CÓDIGO] DevelopmentSessionRecoveryReconciler reenfileira a
  -- mesma subtarefa quando a sessão desaparece/falha.
  ('E40_DEVELOPMENT_SESSION_LOST', 'Sessão DEV ausente ou encerrada com falha', 'infra', 'subtarefa', 30, 1),

  -- [JÁ TRATADO NO CÓDIGO] loop de tool calls é interrompido e reenfileirado.
  -- Caminhos possíveis: a) reenfileirar com nova sessão; b) enviar feedback na
  -- sessão atual; c) bloquear após N ocorrências.
  ('E41_DEVELOPMENT_SESSION_LOOP', 'Sessão DEV presa em ciclo repetitivo', 'erro', 'subtarefa', 31, 1),

  -- [JÁ TRATADO NO CÓDIGO] após N lembretes sem ::DONE::, bloqueia a subtarefa.
  ('E42_DEVELOPMENT_PROTOCOL_EXHAUSTED', 'Sessão DEV esgotou o protocolo de conclusão', 'erro', 'subtarefa', 22, 1),

  -- [JÁ TRATADO NO CÓDIGO] execução `running` sem sessão persistida é reenfileirada.
  ('E43_DEVELOPMENT_ORPHAN_EXECUTION', 'Execução DEV órfã sem sessão ativa', 'infra', 'subtarefa', 32, 1),

  -- [JÁ TRATADO NO CÓDIGO] TestGateJobReconciler reenfileira pending/processing
  -- antigos. Precisa de limite para não reenfileirar eternamente um erro permanente.
  ('E44_TEST_GATE_ORPHAN_JOB', 'Job de gate de testes órfão', 'infra', 'subtarefa', 33, 1),

  -- [JÁ TRATADO NO CÓDIGO] TestGateConsumer marca o job failed e relança; a fila
  -- faz retry. [PRECISA DECIDIR O CAMINHO] a) rework DEV; b) Monitor; c) bloquear;
  -- d) retry somente para erro de infraestrutura.
  ('E45_TEST_GATE_EXECUTION_FAILURE', 'Falha ao executar gate de testes', 'verificacao', 'subtarefa', 23, 1),

  -- [JÁ TRATADO NO CÓDIGO] baseline vermelho aciona recuperação pelo Monitor.
  -- Caminhos possíveis: a) Monitor automático; b) aceitar baseline conhecido;
  -- c) bloquear imediatamente por política do projeto.
  ('E46_BASELINE_PREEXISTING_FAILURE', 'Baseline contém falha preexistente', 'verificacao', 'tarefa', 40, 1),

  -- [JÁ TRATADO NO CÓDIGO] TestRecoveryConsumer muda para awaiting_user e escreve
  -- no chat. Caminhos possíveis: a) aguardar usuário; b) nova cadeia de modelos;
  -- c) bloquear deploy mantendo entrega funcional concluída.
  ('E47_TEST_RECOVERY_EXHAUSTED', 'Monitor não conseguiu recuperar o gate', 'verificacao', 'tarefa', 24, 1),

  -- [JÁ TRATADO NO CÓDIGO] OutboxPublisher preserva pending e tenta novamente a
  -- cada polling. [PRECISA DECIDIR O CAMINHO] limite/alerta/circuit breaker.
  ('E48_OUTBOX_PUBLISH_FAILURE', 'Falha ao publicar mensagem do outbox', 'infra', 'global', 34, 1),

  -- [JÁ TRATADO NO CÓDIGO] invariantes de deploy lançam erro e deixam o pedido
  -- sem prosseguir. Caminhos possíveis: a) blocked; b) voltar para integração;
  -- c) pedir configuração ao usuário.
  ('E49_DEPLOY_INVARIANT_FAILURE', 'Tarefa não atende às invariantes de deploy', 'verificacao', 'tarefa', 25, 1),

  -- [JÁ TRATADO NO CÓDIGO] reconciliação remota marca lote/pedidos failed e cria
  -- bloqueio. Caminhos possíveis: a) retry do mesmo lote; b) rollback; c) novo lote.
  ('E50_DEPLOY_REMOTE_FAILURE', 'Deploy remoto falhou ou excedeu timeout', 'infra', 'projeto', 26, 1),

  -- [LACUNA PARCIAL] npm ci/preparo falha e normalmente sobe como exceção genérica.
  -- Caminhos possíveis: a) retry se rede/registry; b) rework se lockfile inválido;
  -- c) bloquear se ferramenta/configuração estiver ausente.
  ('E51_WORKSPACE_ENVIRONMENT_FAILURE', 'Falha na preparação do ambiente do workspace', 'infra', 'subtarefa', 27, 1),

  -- [LACUNA] inclui commit, merge, conflito, worktree inválido e commit sem diff.
  -- Caminhos possíveis: a) rework para erro corrigível; b) serializar/retry para
  -- lock concorrente; c) bloquear para conflito ou corrupção persistente.
  ('E52_GIT_INTEGRATION_FAILURE', 'Falha Git durante verificação ou integração', 'verificacao', 'subtarefa', 28, 1),

  -- [JÁ TRATADO NO CÓDIGO] tarefas de desenvolvimento/deploy são adiadas quando
  -- existe deploy ativo. Caminhos possíveis: a) retry com atraso; b) fila por projeto.
  ('E53_DEPLOY_LOCK_BUSY', 'Lock de deploy ocupado', 'estado', 'projeto', 41, 1),

  -- [JÁ TRATADO NO CÓDIGO] AnalysisSessionRecoveryReconciler fecha sessões antigas,
  -- recupera sessões válidas ou agenda nova análise conforme o estado encontrado.
  ('E54_ANALYSIS_SESSION_ORPHAN', 'Sessão de análise órfã após reinício', 'infra', 'tarefa', 35, 1),

  -- [JÁ TRATADO NO CÓDIGO] WorkerLauncher pode entregar a sessão ao reconciliador;
  -- em fluxos legados a subtarefa podia ficar failed por timeout.
  -- Caminhos possíveis: a) handoff; b) cancelar sessão e retry; c) bloquear.
  ('E55_WORKER_TIMEOUT', 'Worker excedeu timeout ou ficou silencioso', 'infra', 'subtarefa', 29, 1),

  -- [JÁ TRATADO NO CÓDIGO] payload sem subtaskId válido lança exceção e cai no retry/DLQ.
  -- Caminhos possíveis: a) DLQ imediata (erro permanente); b) bloquear tarefa se
  -- identificável; c) alerta de contrato quebrado.
  ('E56_INVALID_SUBTASK_COMMAND', 'Comando de subtarefa com payload inválido', 'erro', 'subtarefa', 12, 1),

  -- [LACUNA GENÉRICA] qualquer comando que esgote retries sem tratador específico.
  -- Caminhos possíveis: a) bloquear agregado; b) alerta apenas; c) Monitor;
  -- d) manter em DLQ para decisão humana. Esta é a política fallback.
  ('E57_UNHANDLED_TERMINAL_MESSAGE_FAILURE', 'Falha terminal sem política específica', 'erro', 'global', 99, 1)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `category` = VALUES(`category`),
  `scope` = VALUES(`scope`),
  `priority` = VALUES(`priority`),
  `active` = VALUES(`active`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. PADRÕES: códigos normalizados que o handler deverá fornecer ao classificador
-- ---------------------------------------------------------------------------

INSERT INTO `motor_patterns` (`event_id`, `pattern`, `match_type`, `match_target`, `active`)
SELECT e.id, definitions.pattern, 'exact', 'code', 1
FROM `motor_events` e
INNER JOIN (
  SELECT 'E36_VERIFICATION_TERMINAL_FAILURE' event_code, 'verification_terminal_failure' pattern UNION ALL
  SELECT 'E37_QUEUE_INVALID_MESSAGE', 'queue_invalid_message' UNION ALL
  SELECT 'E38_QUEUE_UNEXPECTED_PROCESSING_STATE', 'queue_unexpected_processing_state' UNION ALL
  SELECT 'E39_ANALYSIS_TERMINAL_FAILURE', 'analysis_terminal_failure' UNION ALL
  SELECT 'E40_DEVELOPMENT_SESSION_LOST', 'development_session_lost' UNION ALL
  SELECT 'E41_DEVELOPMENT_SESSION_LOOP', 'development_session_loop' UNION ALL
  SELECT 'E42_DEVELOPMENT_PROTOCOL_EXHAUSTED', 'development_protocol_exhausted' UNION ALL
  SELECT 'E43_DEVELOPMENT_ORPHAN_EXECUTION', 'development_orphan_execution' UNION ALL
  SELECT 'E44_TEST_GATE_ORPHAN_JOB', 'test_gate_orphan_job' UNION ALL
  SELECT 'E45_TEST_GATE_EXECUTION_FAILURE', 'test_gate_execution_failure' UNION ALL
  SELECT 'E46_BASELINE_PREEXISTING_FAILURE', 'baseline_preexisting_failure' UNION ALL
  SELECT 'E47_TEST_RECOVERY_EXHAUSTED', 'test_recovery_exhausted' UNION ALL
  SELECT 'E48_OUTBOX_PUBLISH_FAILURE', 'outbox_publish_failure' UNION ALL
  SELECT 'E49_DEPLOY_INVARIANT_FAILURE', 'deploy_invariant_failure' UNION ALL
  SELECT 'E50_DEPLOY_REMOTE_FAILURE', 'deploy_remote_failure' UNION ALL
  SELECT 'E51_WORKSPACE_ENVIRONMENT_FAILURE', 'workspace_environment_failure' UNION ALL
  SELECT 'E52_GIT_INTEGRATION_FAILURE', 'git_integration_failure' UNION ALL
  SELECT 'E53_DEPLOY_LOCK_BUSY', 'deploy_lock_busy' UNION ALL
  SELECT 'E54_ANALYSIS_SESSION_ORPHAN', 'analysis_session_orphan' UNION ALL
  SELECT 'E55_WORKER_TIMEOUT', 'worker_timeout' UNION ALL
  SELECT 'E56_INVALID_SUBTASK_COMMAND', 'invalid_subtask_command' UNION ALL
  SELECT 'E57_UNHANDLED_TERMINAL_MESSAGE_FAILURE', 'unhandled_terminal_message_failure'
) definitions ON definitions.event_code = e.code
WHERE NOT EXISTS (
  SELECT 1 FROM `motor_patterns` p
  WHERE p.event_id = e.id
    AND p.pattern = definitions.pattern
    AND p.match_type = 'exact'
    AND p.match_target = 'code'
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. AÇÕES-CANDIDATAS: composição segura; INATIVAS até existir executor durável
-- ---------------------------------------------------------------------------

-- [PRECISA DECIDIR O CAMINHO]
-- A23 é a decisão proposta para E36. Para ser ativada, `block_subtask` e
-- `persist_blocker` precisam executar na mesma transação, junto com evento/chat.
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT
  'A23_BLOCK_VERIFICATION_SUBTASK',
  'Bloquear subtarefa após falha terminal de verificação',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'block_subtask', 'params', JSON_OBJECT('reason', 'verification_terminal_failure')),
    JSON_OBJECT('primitive', 'persist_blocker', 'params', JSON_OBJECT('type', 'verification_failed')),
    JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'error', 'message', 'Verificação atingiu o limite de tentativas'))
  ),
  'mark_dirty', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A23_BLOCK_VERIFICATION_SUBTASK');
--> statement-breakpoint

-- [PRECISA DECIDIR O CAMINHO]
-- A24 representa o fallback conservador: registrar e alertar sem alterar sozinho
-- uma tarefa cujo tipo de comando não possua política terminal específica.
-- Hoje só existe `log`; publicação de alerta/chat precisa de uma primitiva própria.
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT
  'A24_RECORD_UNHANDLED_TERMINAL_FAILURE',
  'Registrar falha terminal sem política específica',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'error', 'message', 'Mensagem esgotou tentativas sem política terminal específica'))
  ),
  'continue', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A24_RECORD_UNHANDLED_TERMINAL_FAILURE');
--> statement-breakpoint

-- [JÁ TRATADO NO CÓDIGO]
-- A25 documenta a política vigente de falha terminal de análise. O runtime atual
-- usa MySqlAnalysisFailureBlocker, não esta ação. Só ativar após substituir o
-- hardcode por execução transacional equivalente via catálogo.
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT
  'A25_BLOCK_TASK_AFTER_ANALYSIS_FAILURE',
  'Bloquear tarefa após falha terminal de análise',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'block_task', 'params', JSON_OBJECT('reason', 'analysis_failed')),
    JSON_OBJECT('primitive', 'persist_blocker', 'params', JSON_OBJECT('type', 'analysis_failed')),
    JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'error', 'message', 'Análise atingiu o limite de tentativas'))
  ),
  'mark_dirty', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A25_BLOCK_TASK_AFTER_ANALYSIS_FAILURE');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. REAÇÕES-CANDIDATAS: INATIVAS deliberadamente
-- ---------------------------------------------------------------------------

-- E36 caminhos possíveis:
--   a) A23 bloquear e permitir retomada administrativa (RECOMENDADO);
--   b) voltar para rework automaticamente;
--   c) manter verifying e somente alertar (rejeitado: reproduz o incidente 899).
INSERT INTO `motor_reactions` (`event_id`, `occurrence`, `action_id`, `params_json`, `active`)
SELECT e.id, 1, a.id,
       JSON_OBJECT('decision_status', 'pending_runtime_wiring', 'recommended', 'block_and_allow_resume'), 0
FROM `motor_events` e
INNER JOIN `motor_actions` a ON a.code = 'A23_BLOCK_VERIFICATION_SUBTASK'
WHERE e.code = 'E36_VERIFICATION_TERMINAL_FAILURE'
  AND NOT EXISTS (
    SELECT 1 FROM `motor_reactions` r
    WHERE r.event_id = e.id AND r.occurrence = 1 AND r.action_id = a.id
  );
--> statement-breakpoint

-- E39 já tratado no código. Esta reação documenta a decisão atual, mas permanece
-- inativa enquanto o hardcode for a autoridade para evitar bloqueio duplicado.
INSERT INTO `motor_reactions` (`event_id`, `occurrence`, `action_id`, `params_json`, `active`)
SELECT e.id, 1, a.id,
       JSON_OBJECT('decision_status', 'already_hardcoded', 'current_handler', 'MySqlAnalysisFailureBlocker'), 0
FROM `motor_events` e
INNER JOIN `motor_actions` a ON a.code = 'A25_BLOCK_TASK_AFTER_ANALYSIS_FAILURE'
WHERE e.code = 'E39_ANALYSIS_TERMINAL_FAILURE'
  AND NOT EXISTS (
    SELECT 1 FROM `motor_reactions` r
    WHERE r.event_id = e.id AND r.occurrence = 1 AND r.action_id = a.id
  );
--> statement-breakpoint

-- E57 caminhos possíveis:
--   a) somente registrar + alertar e manter DLQ (RECOMENDADO como fallback);
--   b) bloquear toda tarefa automaticamente (risco de falso positivo);
--   c) chamar Monitor para decidir (maior custo e possível loop).
INSERT INTO `motor_reactions` (`event_id`, `occurrence`, `action_id`, `params_json`, `active`)
SELECT e.id, 1, a.id,
       JSON_OBJECT('decision_status', 'needs_decision', 'options', JSON_ARRAY('record_and_alert', 'block_task', 'ask_monitor')), 0
FROM `motor_events` e
INNER JOIN `motor_actions` a ON a.code = 'A24_RECORD_UNHANDLED_TERMINAL_FAILURE'
WHERE e.code = 'E57_UNHANDLED_TERMINAL_MESSAGE_FAILURE'
  AND NOT EXISTS (
    SELECT 1 FROM `motor_reactions` r
    WHERE r.event_id = e.id AND r.occurrence = 1 AND r.action_id = a.id
  );

-- ---------------------------------------------------------------------------
-- 5. MATRIZ DE DECISÃO A IMPLEMENTAR NO RUNTIME (documentação executável futura)
-- ---------------------------------------------------------------------------
--
-- COMO LER ESTA MATRIZ
--   "O que é": situação concreta que originou o evento.
--   "Hoje": comportamento encontrado no código atual.
--   "Risco": consequência de manter o comportamento sem uma política explícita.
--   "Opções": decisões que poderão ser selecionadas pelo catálogo depois que o
--   handler estiver conectado. A opção marcada RECOMENDADA é uma proposta para
--   revisão, não uma decisão já ativada por esta migration.
--
-- ---------------------------------------------------------------------------
-- E36_VERIFICATION_TERMINAL_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   A subtarefa terminou o desenvolvimento e entrou em `verifying`, mas a etapa
--   que cria o commit, confere o gate ou integra a branch falhou até esgotar as
--   tentativas. Foi exatamente o cenário da tarefa 899.
-- Hoje:
--   A mensagem vai para a DLQ e a subtarefa pode continuar em `verifying`, sem
--   worker ativo e sem mensagem visível para o usuário.
-- Risco:
--   A tela mostra a tarefa como executando eternamente, embora ninguém esteja
--   trabalhando nela.
-- Opções:
--   a) RECOMENDADA: mudar para `blocked`, registrar bloqueio/chat/evento e
--      permitir retomada administrativa depois da correção.
--   b) Voltar automaticamente para `rework`, entregando o erro ao programador.
--   c) Repetir a verificação indefinidamente. Não recomendado: pode criar loop.
--  PERGUNTA: A gente consegue identificar se o erro foi do dev, do motor ou do ambiente?
--  RESPOSTA:
--   Sim, mas hoje essa identificação ainda não é confiável em todos os pontos.
--   Para funcionar, o erro precisa chegar ao handler com dados estruturados:
--     - estágio: environment, gate, commit, merge, integration ou persistence;
--     - origem: developer_change, motor_internal, infrastructure ou unknown;
--     - código estável: por exemplo lockfile_invalid, git_conflict, db_unavailable;
--     - evidências: comando, exit code e trecho sanitizado da saída.
--   Exemplos:
--     - Teste que passou no baseline e falhou depois da alteração: provavelmente
--       `developer_change`; deve voltar para rework.
--     - Falha no banco, RabbitMQ, disco, rede ou registry: `infrastructure`; deve
--       fazer retry controlado e depois gerar alerta operacional.
--     - Estado impossível, transação incompleta ou exceção no orquestrador:
--       `motor_internal`; deve bloquear de forma visível e abrir ocorrência.
--     - Conflito Git pode ser `developer_change` ou concorrência do Motor; precisa
--       comparar base, branch e lock antes de classificar.
--   Quando não houver evidência suficiente, a origem deve ser `unknown`. O Motor
--   não deve culpar o DEV por presunção; deve preservar o trabalho, bloquear e
--   apresentar as evidências para decisão/retomada. OK
-- ---------------------------------------------------------------------------
-- E37_QUEUE_INVALID_MESSAGE
-- ---------------------------------------------------------------------------
-- O que é:
--   A fila recebeu uma mensagem sem campos obrigatórios, como messageId, type ou
--   taskId. Não há dados suficientes para executar o comando com segurança.
-- Hoje:
--   O QueueConsumer envia a mensagem imediatamente para a DLQ.
-- Risco:
--   O defeito de quem publicou a mensagem pode passar despercebido e se repetir.
-- Opções:
--   a) RECOMENDADA: DLQ imediata, sem retry, mais alerta e métrica por produtor.
--   b) Apenas DLQ, mantendo o comportamento atual.
--   c) Tentar completar dados ausentes. Não recomendado: pode atingir outra tarefa.
--
--  Pergunta: Eu ainda não entendi a opção a). Se o erro foi de quem enviou não teria que voltar para corrigir?
--  RESPOSTA:
--   Sim, o produtor precisa ser corrigido. "DLQ imediata" significa que a mesma
--   mensagem inválida não deve ser repetida, pois reenfileirá-la não preencherá os
--   campos ausentes. Em uma fila assíncrona não existe um retorno de chamada como
--   numa requisição HTTP; o equivalente seguro é:
--     1. preservar a mensagem inválida na DLQ como evidência;
--     2. identificar o produtor por tipo, origem/correlationId e versão do contrato;
--     3. registrar alerta/ocorrência apontando para o produtor responsável;
--     4. corrigir o código/configuração que publicou o envelope;
--     5. publicar uma NOVA mensagem válida, com novo messageId e causationId
--        apontando para a mensagem defeituosa.
--   Se taskId/subtaskId forem confiáveis, a tarefa também deve ficar visivelmente
--   bloqueada ou aguardando correção. O que não devemos fazer é retry automático
--   da mensagem quebrada nem inventar os identificadores ausentes. OK
-- ---------------------------------------------------------------------------
-- E38_QUEUE_UNEXPECTED_PROCESSING_STATE
-- ---------------------------------------------------------------------------
-- O que é:
--   O registro de idempotência da mensagem está em um estado que não permite
--   adquirir o processamento nem reconhecê-lo como concluído ou ainda ativo.
-- Hoje:
--   A mensagem é enviada diretamente para a DLQ.
-- Risco:
--   Uma interrupção entre banco e RabbitMQ pode transformar um trabalho válido
--   em mensagem morta sem corrigir o estado da tarefa.
-- Opções:
--  OK a) RECOMENDADA: recuperar automaticamente quando o lease estiver expirado;
--      caso contrário, alertar e enviar para DLQ.
--   b) DLQ imediata com alerta para intervenção humana.
--   c) Resetar sempre para pending. Não recomendado: pode executar duas vezes.
--
-- ---------------------------------------------------------------------------
-- E39_ANALYSIS_TERMINAL_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   O Analista não conseguiu produzir um plano válido após todas as tentativas.
-- Hoje:
--   TaskCoordinator e MySqlAnalysisFailureBlocker criam um bloqueio e publicam
--   TASK_BLOCKED pela outbox. Essa decisão está hardcoded.
-- Risco:
--   Ao migrar para o catálogo, o código antigo e a reação nova podem criar dois
--   bloqueios ou duas mensagens se forem ativados ao mesmo tempo.
-- Opções:
--  OK a) RECOMENDADA: manter a decisão atual, mas transferi-la atomicamente para o
--      handler do catálogo e depois remover o hardcode.
--   b) Enviar antes para outro modelo e bloquear somente após esgotar a cadeia.
--   c) Voltar a tarefa para planned. Não recomendado: esconde a falha definitiva.
--
-- ---------------------------------------------------------------------------
-- E40_DEVELOPMENT_SESSION_LOST
-- ---------------------------------------------------------------------------
-- O que é:
--   A subtarefa está running, mas a sessão DEV desapareceu do Console ou foi
--   encerrada com erro antes de concluir.
-- Hoje:
--   O reconciliador cria outra mensagem e tenta novamente a subtarefa.
-- Risco:
--   Uma causa permanente pode gerar novas sessões indefinidamente e consumir
--   modelos sem produzir avanço.
-- Opções:
--   a) RECOMENDADA: reenfileirar até um limite configurável e depois bloquear.
--   b) Reenfileirar sem limite, como hoje.
--   c) Bloquear na primeira perda. Mais seguro, porém sensível a falhas transitórias.
--  Concordo com a A, mas se existir um reconciliador que tentará novamente depois de um bom tempo
-- ---------------------------------------------------------------------------
-- E41_DEVELOPMENT_SESSION_LOOP
-- ---------------------------------------------------------------------------
-- O que é:
--   O agente repete a mesma ferramenta ou ação várias vezes sem avançar.
-- Hoje:
--   O reconciliador encerra/interrompe o ciclo e reenfileira a execução.
-- Risco:
--   A nova sessão pode repetir exatamente o mesmo ciclo, causando custo e atraso.
-- Opções:
--   a) Enviar feedback corretivo na mesma sessão antes de reiniciar.
--   OK b) RECOMENDADA: nova sessão com diagnóstico do ciclo e limite de ocorrências.
--   c) Bloquear imediatamente para revisão humana.
--
-- ---------------------------------------------------------------------------
-- E42_DEVELOPMENT_PROTOCOL_EXHAUSTED
-- ---------------------------------------------------------------------------
-- O que é:
--   A sessão terminou ou ficou ociosa sem resposta final e sem o marcador
--   `::DONE::`, mesmo depois dos lembretes de conclusão.
-- Hoje:
--   Depois do limite de nudges, a subtarefa é bloqueada por código.
-- Risco:
--   Ao migrar parcialmente, podemos perder a contagem persistida dos lembretes
--   ou enviar mensagens duplicadas ao agente.
-- Opções:
--   Ok a) RECOMENDADA: preservar nudges e cooldown atuais, mas deixar quantidade e
--      ação final configuráveis no catálogo.
--   b) Abrir uma sessão nova antes de bloquear.
--   c) Aceitar a entrega sem `::DONE::`. Não recomendado: contrato incompleto.
--
-- ---------------------------------------------------------------------------
-- E43_DEVELOPMENT_ORPHAN_EXECUTION
-- ---------------------------------------------------------------------------
-- O que é:
--   A subtarefa está running há muito tempo, sem sessão ativa e sem mensagem de
--   execução sendo processada. Normalmente ocorre após crash ou reinício.
-- Hoje:
--   O reconciliador reenfileira a subtarefa.
-- Risco:
--   Sem marcador de recuperação e limite, ciclos de reconciliação podem criar
--   várias tentativas para o mesmo problema permanente.
-- Opções:
--   OK a) RECOMENDADA: reenfileirar idempotentemente uma vez e bloquear se voltar
--      a ficar órfã dentro da mesma geração.
--   b) Reenfileirar sempre.
--   c) Bloquear na primeira detecção.
--
-- ---------------------------------------------------------------------------
-- E44_TEST_GATE_ORPHAN_JOB
-- ---------------------------------------------------------------------------
-- O que é:
--   Um job de build/teste ficou pending ou processing sem worker vivo, geralmente
--   por restart durante o gate.
-- Hoje:
--   TestGateJobReconciler publica novamente TEST_RUN_REQUESTED.
-- Risco:
--   Um job que sempre falha antes de atualizar seu estado pode ser republicado
--   indefinidamente.
-- Opções:
--   OK a) RECOMENDADA: reenfileirar com contador durável e alertar/bloquear após N.
--   b) Reenfileirar sem limite.
--   c) Marcar failed imediatamente e deixar a subtarefa decidir o próximo passo.
--
-- ---------------------------------------------------------------------------
-- E45_TEST_GATE_EXECUTION_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   O comando de build/teste não pôde ser executado ou terminou com erro. Pode
--   ser defeito do código, dependência ausente, timeout ou falha de infraestrutura.
-- Hoje:
--   O job vira failed; a exceção sobe e a fila repete até o limite.
-- Risco:
--   Falhas permanentes são repetidas como se fossem transitórias; ao final, o
--   estado de negócio pode não explicar claramente o que ocorreu.
-- Opções:
--   OK a) RECOMENDADA: classificar a origem. Infra transitória faz retry; regressão
--      nova volta para rework; configuração inválida bloqueia; baseline antigo
--      segue para recuperação do Monitor.
--   b) Enviar qualquer falha para rework.
--   c) Bloquear qualquer falha depois do primeiro gate.
--
-- ---------------------------------------------------------------------------
-- E46_BASELINE_PREEXISTING_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   Antes da alteração do agente, o repositório já falhava no build ou nos testes.
--   Portanto, a tarefa atual não é necessariamente a causa do erro.
-- Hoje:
--   O Motor cria uma recuperação separada e entrega as falhas ao Monitor.
-- Risco:
--   Projetos diferentes podem exigir políticas diferentes; alguns aceitam falhas
--   conhecidas, outros exigem baseline totalmente verde.
-- Opções:
--   OK a) RECOMENDADA: política por projeto: Monitor automático, bloqueio ou baseline
--      conhecido explicitamente aceito.
--   b) Sempre acionar o Monitor, como hoje.
--   c) Prosseguir ignorando baseline vermelho. Alto risco sem aceite explícito.
--
-- ---------------------------------------------------------------------------
-- E47_TEST_RECOVERY_EXHAUSTED
-- ---------------------------------------------------------------------------
-- O que é:
--   O Monitor tentou corrigir falhas preexistentes, mas não conseguiu deixar o
--   gate verde.
-- Hoje:
--   A recuperação vira awaiting_user e uma explicação é escrita no chat. A
--   entrega funcional permanece concluída, mas o deploy fica impedido.
-- Risco:
--   A tarefa pode permanecer aguardando sem oferecer uma ação clara de retomada.
-- Opções:
--   OK a) RECOMENDADA: manter awaiting_user e oferecer comando explícito de retomar.
--   b) Tentar o próximo modelo configurado antes de pedir intervenção.
--   c) Bloquear formalmente o deploy e abrir tarefa técnica separada.
--
-- ---------------------------------------------------------------------------
-- E48_OUTBOX_PUBLISH_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   O evento foi salvo no banco, mas não pôde ser publicado no RabbitMQ.
-- Hoje:
--   A linha permanece pending e o polling tenta novamente sem limite.
-- Risco:
--   Falha prolongada pode acumular mensagens, poluir logs e não gerar alerta.
-- Opções:
--   OK a) RECOMENDADA: retry com backoff, métrica e alerta após limite de tempo;
--      manter pending para não perder a mensagem.
--   b) Retry frequente sem limite, como hoje.
--   c) Marcar failed e desistir. Não recomendado: quebra garantia da outbox.
--
-- ---------------------------------------------------------------------------
-- E49_DEPLOY_INVARIANT_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   A tarefa pediu deploy sem atender pré-condições: integração confirmada, gate
--   verde, configuração completa, commit válido ou ausência de bloqueios.
-- Hoje:
--   O consumidor lança exceção; o tratamento posterior depende da fila/retry.
-- Risco:
--   Repetir não corrige configuração ou gate vermelho e pode terminar em DLQ sem
--   orientação ao usuário.
-- Opções:
--   OK a) RECOMENDADA: classificar a invariante: configuração ausente pede usuário;
--      gate vermelho volta à correção; bloqueio mantém deploy aguardando.
--   b) Bloquear a tarefa genericamente.
--   c) Repetir automaticamente. Útil somente se a condição for transitória.
--
-- ---------------------------------------------------------------------------
-- E50_DEPLOY_REMOTE_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   O processo blue-green remoto retornou erro, não produziu resultado no prazo
--   ou ficou inacessível por SSH.
-- Hoje:
--   O lote e seus pedidos viram failed e é criado um bloqueio.
-- Risco:
--   Repetir um deploy parcialmente executado pode afetar o ambiente sem saber se
--   houve troca de versão ou se rollback já ocorreu.
-- Opções:
--   OK a) RECOMENDADA: consultar estado remoto; se nenhum efeito ocorreu, novo lote;
--      se houve troca parcial, rollback; se estado for incerto, intervenção humana.
--   b) Repetir automaticamente o mesmo lote.
--   c) Manter bloqueado até confirmação manual.
--
-- ---------------------------------------------------------------------------
-- E51_WORKSPACE_ENVIRONMENT_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   A preparação do worktree falhou, por exemplo durante `npm ci`, acesso ao
--   registry, lockfile inválido, falta de disco ou ferramenta ausente.
-- Hoje:
--   Normalmente sobe como exceção genérica e segue a política geral de retry/DLQ.
-- Risco:
--   Causas diferentes recebem o mesmo tratamento; `npm ci` com lockfile inválido
--   nunca será corrigido por simples repetição.
-- Opções:
--   OK a) RECOMENDADA: rede/registry faz retry; lockfile inválido volta para rework;
--      ferramenta/configuração ausente bloqueia e informa o usuário; disco gera
--      alerta operacional.
--   b) Repetir todos os casos.
--   c) Bloquear todos os casos na primeira ocorrência.
--
-- ---------------------------------------------------------------------------
-- E52_GIT_INTEGRATION_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   Falhou alguma operação Git de verificação ou integração: worktree ausente,
--   nenhum diff, commit inválido, lock concorrente, conflito de merge ou corrupção.
-- Hoje:
--   A exceção sobe genericamente; foi a família que deixou a tarefa 899 órfã.
-- Risco:
--   Um lock transitório e um conflito real recebem retries iguais, e a subtarefa
--   pode continuar em verifying depois da DLQ.
-- Opções:
--   OK a) RECOMENDADA: lock concorrente faz retry; ausência de alterações volta para
--      rework; conflito/corrupção bloqueia com diagnóstico; worktree perdido pode
--      ser reconstruído somente se houver evidência persistida suficiente.
--   b) Voltar qualquer falha para rework.
--   c) Bloquear qualquer falha Git.
--
-- ---------------------------------------------------------------------------
-- E53_DEPLOY_LOCK_BUSY
-- ---------------------------------------------------------------------------
-- O que é:
--   Uma tarefa tentou iniciar desenvolvimento ou deploy enquanto outro deploy
--   mantém o lock necessário para preservar consistência da branch/projeto.
-- Hoje:
--   O comando é republicado com atraso.
-- Risco:
--   Muitos comandos adiados podem disputar novamente ao mesmo tempo e criar fila
--   invisível ou starvation.
-- Opções:
--   OK a) RECOMENDADA: manter o adiamento, com fila/ordenação por projeto e backoff.
--   b) Retry fixo como hoje.
--   c) Bloquear novas tarefas durante deploy. Simples, porém reduz concorrência.
--
-- ---------------------------------------------------------------------------
-- E54_ANALYSIS_SESSION_ORPHAN
-- ---------------------------------------------------------------------------
-- O que é:
--   Após reinício, existe sessão de Analista marcada ativa sem worker local, ou
--   análise claimed sem processo responsável.
-- Hoje:
--   AnalysisSessionRecoveryReconciler examina checkpoint/status da sessão, fecha
--   registros antigos ou agenda continuação/nova análise.
-- Risco:
--   Transferir apenas parte dessa lógica para o catálogo pode perder checkpoints
--   e iniciar dois analistas para a mesma tarefa.
-- Opções:
--   OK a) RECOMENDADA: manter o reconciliador especializado; catálogo escolhe apenas
--      a ação depois que ele classificar a situação encontrada.
--   b) Mover toda a recuperação para ações do catálogo.
--   c) Fechar e reiniciar toda sessão órfã, descartando continuidade.
--  Pergunta: Quando você diz manter o reconciliador especializado, signigica que ele vai virar uma primitiva?
--  RESPOSTA:
--   Não. O reconciliador deve continuar sendo um processo periódico especializado,
--   responsável por localizar sessões potencialmente órfãs e reunir evidências.
--   Ele é o detector do problema, não a ação atômica que resolve o problema.
--
--   Fluxo recomendado:
--     reconciliador detecta e consulta checkpoint/status da sessão
--       -> publica/classifica E54 com os fatos encontrados
--       -> catálogo escolhe a reação
--       -> ActionExecutor executa primitivas pequenas e idempotentes
--
--   Partes atômicas podem virar primitivas, por exemplo:
--     - `close_orphan_analysis_session`;
--     - `resume_analysis_session`;
--     - `requeue_analysis`;
--     - `persist_analysis_recovery_event`.
--   Porém, transformar o ciclo inteiro do reconciliador em uma única primitiva
--   grande apenas mudaria o hardcode de lugar e impediria o catálogo de combinar
--   ações. O reconciliador detecta; o catálogo decide; as primitivas executam. OK
-- ---------------------------------------------------------------------------
-- E55_WORKER_TIMEOUT
-- ---------------------------------------------------------------------------
-- O que é:
--   O worker ultrapassou o tempo global ou ficou sem atividade por tempo demais.
--   A sessão remota pode ainda estar viva e preservar trabalho útil.
-- Hoje:
--   Em fluxos novos ocorre handoff ao reconciliador; fluxos legados podiam marcar
--   a subtarefa failed e depois tentar reabri-la.
-- Risco:
--   Cancelar cedo perde trabalho; esperar indefinidamente deixa a tarefa presa.
-- Opções:
--   OK a) RECOMENDADA: handoff quando a sessão estiver viva; retry se desapareceu;
--      bloquear após reincidência ou timeout absoluto.
--   b) Cancelar e criar sessão nova sempre.
--   c) Bloquear imediatamente.
--
-- ---------------------------------------------------------------------------
-- E56_INVALID_SUBTASK_COMMAND
-- ---------------------------------------------------------------------------
-- O que é:
--   Uma mensagem de subtarefa chegou sem subtaskId válido ou com contrato de
--   payload incompatível com o consumidor.
-- Hoje:
--   O consumidor lança erro; a fila repete e depois envia para DLQ.
-- Risco:
--   É um erro permanente de contrato; retries apenas atrasam o diagnóstico.
-- Opções:
--   OK a) RECOMENDADA: DLQ imediata, alerta de contrato e bloqueio somente se a
--      tarefa afetada puder ser identificada com certeza.
--   b) Manter retries para tolerar migração temporária entre versões.
--   c) Tentar inferir subtaskId. Não recomendado: risco de executar alvo errado.
--
-- ---------------------------------------------------------------------------
-- E57_UNHANDLED_TERMINAL_MESSAGE_FAILURE
-- ---------------------------------------------------------------------------
-- O que é:
--   Uma mensagem esgotou tentativas, mas seu tipo ainda não possui política
--   terminal específica no catálogo. É a rede de segurança para casos novos.
-- Hoje:
--   A mensagem vai para a DLQ e nenhuma decisão de domínio é garantida.
-- Risco:
--   Pode repetir o incidente 899 em outro estágio: estado intermediário sem
--   worker, sem alerta e sem caminho de retomada.
-- Opções:
--   a) RECOMENDADA COMO PRIMEIRA BARREIRA: registrar ocorrência, alertar e manter
--      a mensagem na DLQ sem alterar automaticamente o domínio.
--   b) Bloquear toda tarefa associada. Visível, mas pode gerar falso bloqueio.
--   c) Depois da barreira a), pedir ao Monitor para diagnosticar e criar uma
--      TAREFA CORRETIVA pausada, identificada como criada pelo Monitor, vinculada
--      ao incidente e com uma explicação didática no chat.
-- Porque a primeira é a recomendada? A c não seria melhor? Explique sua decisão.
-- RESPOSTA:
--   Sim. Criar uma tarefa corretiva pausada é uma saída melhor e mais visível do
--   que salvar somente uma proposta em motor_catalog_proposals. Ela transforma o
--   incidente desconhecido em trabalho revisável, sem autorizar sua execução.
--
--   Mesmo assim, a opção c não substitui a opção a como primeira barreira de
--   segurança. Quando chegamos ao E57, por definição não conhecemos suficientemente
--   o erro nem sua consequência. Pedir ao Monitor que decida e execute
--   imediatamente pode:
--     - interpretar evidência incompleta;
--     - alterar a tarefa errada ou escolher uma transição inválida;
--     - criar um loop em que a própria falha do Monitor gera outro E57;
--     - consumir modelo enquanto o incidente continua sem registro operacional;
--     - autoativar uma solução inédita sem revisão humana.
--
--   Portanto, a recomendação completa continua sendo `a -> c`, mas c passa a
--   significar "criar tarefa corretiva pausada", não apenas "criar proposta":
--     1. a) preservar a mensagem, registrar e alertar, sem mutação arriscada;
--     2. c) acionar o Monitor somente em modo diagnóstico;
--     3. criar uma nova tarefa com `paused_at=NOW()`, sem comando de início;
--     4. registrar em tarefa_eventos:
--          evento='task_created_by_monitor', ator='monitor', origem='motor',
--          payload com sourceTaskId, sourceSubtaskId, sourceMessageId, eventCode,
--          correlationId, diagnóstico e evidências sanitizadas;
--     5. inserir em tarefa_chats uma mensagem explicando:
--          - qual incidente originou a tarefa;
--          - o que o Monitor encontrou;
--          - por que nenhuma correção foi executada automaticamente;
--          - quais caminhos ele sugere;
--          - o que o usuário precisa revisar para despausar;
--     6. opcionalmente salvar uma proposta em motor_catalog_proposals como
--        pending_review, vinculando seu id no payload do evento/chat;
--     7. depois da aprovação humana, despausar a tarefa corretiva;
--     8. após a correção, retomar a mensagem original por comando administrativo
--        idempotente, usando novo messageId e causationId para preservar a trilha.
--
--   COMO IDENTIFICAR QUE A TAREFA FOI CRIADA PELO MONITOR COM O SCHEMA ATUAL
--   O schema já permite:
--     - pausa: tarefas.paused_at;
--     - autoria/auditoria: tarefa_eventos.ator='monitor' e origem='motor';
--     - explicação: tarefa_chats;
--     - vínculo com o incidente: tarefa_eventos.payload.
--   Não é necessário adicionar agora um campo `tarefas.created_by`. A fonte
--   canônica da autoria pode ser o evento `task_created_by_monitor`. Se a UI
--   precisar filtrar isso com muita frequência, podemos futuramente materializar
--   `created_by` em tarefas, mantendo tarefa_eventos como trilha de auditoria.
--
--   CUIDADOS
--     - Uma chave idempotente, por exemplo `terminal-failure:<sourceMessageId>`,
--       deve impedir a criação de várias tarefas para a mesma mensagem.
--     - A tarefa corretiva deve nascer pausada e nunca usar auto_start.
--     - Criar tarefa/chat/evento/proposta deve ocorrer em uma única transação.
--     - O Monitor pode sugerir a solução; não deve despausar a própria tarefa.
--     - Depois que o caso for aprovado e catalogado, ocorrências futuras deixam
--       de cair em E57 e seguem a política específica correspondente.
