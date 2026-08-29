ALTER TABLE `subtarefas`
  ADD COLUMN `correction_for_subtask_id` bigint unsigned,
  ADD COLUMN `correction_fingerprint` varchar(500),
  ADD COLUMN `correction_created_at` timestamp NULL;

ALTER TABLE `subtarefas`
  ADD CONSTRAINT `subtarefas_correction_for_subtask_id_fk`
  FOREIGN KEY (`correction_for_subtask_id`) REFERENCES `subtarefas`(`id`) ON DELETE CASCADE;

CREATE TABLE `subtask_gate_failures` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `subtarefa_id` bigint unsigned NOT NULL,
  `fingerprint` varchar(500) NOT NULL,
  `reason` text NOT NULL,
  `model` varchar(255),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `subtask_gate_failures_id` PRIMARY KEY(`id`),
  CONSTRAINT `subtask_gate_failures_subtarefa_id_fk`
    FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas`(`id`) ON DELETE CASCADE,
  INDEX `idx_gate_failures_subtask_fingerprint` (`subtarefa_id`, `fingerprint`)
);
