CREATE TABLE IF NOT EXISTS `motor_configuracoes` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `chave` varchar(150) NOT NULL,
  `tipo` enum('number','string','boolean') NOT NULL,
  `valor` json NOT NULL,
  `valor_padrao` json NOT NULL,
  `regra_validacao` varchar(500) NOT NULL,
  `descricao` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `motor_configuracoes_id` PRIMARY KEY(`id`),
  CONSTRAINT `motor_configuracoes_chave_unique` UNIQUE(`chave`)
);

INSERT IGNORE INTO `motor_configuracoes` (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`) VALUES
('motor.max_workers','number','1','1','inteiro entre 1 e 100','Número máximo global de tarefas de desenvolvimento em paralelo.'),
('motor.max_workers_per_project','number','1','1','inteiro entre 1 e 100','Número máximo de tarefas em paralelo por projeto.'),
('motor.pump_interval_ms','number','30000','30000','inteiro entre 1000 e 3600000','Intervalo de consulta da fila de tarefas.'),
('motor.reconciler_interval_ms','number','30000','30000','inteiro entre 1000 e 3600000','Intervalo de reconciliação de leases e execuções órfãs.'),
('motor.worker_timeout_ms','number','14400000','14400000','inteiro entre 60000 e 86400000','Tempo máximo de execução de um worker.'),
('motor.worker_silence_timeout_ms','number','600000','600000','inteiro entre 30000 e 86400000','Tempo sem heartbeat antes de considerar o worker travado.'),
('motor.resource_lease_ms','number','600000','600000','inteiro entre 30000 e 86400000','Duração do lease de um recurso exclusivo.'),
('motor.resource_heartbeat_interval_ms','number','30000','30000','inteiro entre 1000 e 86400000','Intervalo de renovação dos leases de recursos.'),
('motor.console_run_absolute_timeout_ms','number','14400000','14400000','inteiro entre 60000 e 86400000','Tempo máximo absoluto de uma execução remota no Console.'),
('motor.console_run_idle_timeout_ms','number','600000','600000','inteiro entre 30000 e 86400000','Tempo sem progresso permitido em uma execução remota.'),
('motor.console_poll_interval_ms','number','5000','5000','inteiro entre 1000 e 600000','Intervalo de consulta do estado de uma execução remota.'),
('motor.console_send_timeout_ms','number','600000','600000','inteiro entre 10000 e 3600000','Tempo máximo para enviar uma mensagem ao Console.'),
('motor.dependency_install_timeout_ms','number','900000','900000','inteiro entre 10000 e 3600000','Tempo máximo para instalar dependências.'),
('motor.worker_shutdown_timeout_ms','number','10000','10000','inteiro entre 1000 e 120000','Tempo de encerramento gracioso de workers.'),
('motor.resource_event_wait_timeout_ms','number','30000','30000','inteiro entre 1000 e 3600000','Tempo máximo de espera por evento de recurso.'),
('motor.baseline_confirmation_timeout_ms','number','300000','300000','inteiro entre 10000 e 3600000','Tempo máximo para confirmar o baseline.');
