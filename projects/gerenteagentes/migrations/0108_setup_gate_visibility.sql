-- Tarefa motor-visibilidade-setup-not-verified (brief 2026-11-19):
-- visibilidade e auto-recuperação do gate 'setup_not_verified'.
--
-- (1) Sub-motivo da espera de capacidade em task_runtime_facts: estado derivado
--     do setup do projeto (setup_faltando | setup_failed | setup_em_andamento),
--     resumo do erro real (LEFT 300) e detalhe legível (re-disparo/backoff).
--     Consumido pela projeção capacityWait de GET /api/motor/task/:id e pelo
--     Mapa de agentes (TaskFlowMap). Limpeza canônica: as colunas seguem o
--     CAPACITY_WAIT_CLEAR_ASSIGNMENTS (shared/capacityWait.ts).
ALTER TABLE `task_runtime_facts`
  ADD COLUMN `capacity_wait_setup_state` varchar(30) NULL,
  ADD COLUMN `capacity_wait_setup_error` text NULL,
  ADD COLUMN `capacity_wait_detail` text NULL;
--> statement-breakpoint
-- (2) Controle da auto-recuperação POR PROJETO em projetos_captados:
--     contador + marcador do re-disparo idempotente da missão de setup
--     (backoff configurável, teto de tentativas) e marcador da janela do
--     alerta único (sem spam no chat/Monitor).
ALTER TABLE `projetos_captados`
  ADD COLUMN `setup_redispatch_count` int NOT NULL DEFAULT 0,
  ADD COLUMN `setup_redispatch_last_at` datetime NULL,
  ADD COLUMN `setup_alert_last_at` datetime NULL;
