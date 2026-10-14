-- Dependências N:N entre tarefas. A coluna legada é preservada e continua
-- espelhando a primeira dependência para consumidores antigos.
CREATE TABLE `tarefa_dependencias` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tarefa_id` bigint unsigned NOT NULL,
  `depende_de_tarefa_id` bigint unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tarefa_dependencias_tarefa_depende_unica` (`tarefa_id`, `depende_de_tarefa_id`),
  KEY `tarefa_dependencias_tarefa_idx` (`tarefa_id`),
  KEY `tarefa_dependencias_depende_de_idx` (`depende_de_tarefa_id`),
  CONSTRAINT `tarefa_dependencias_tarefa_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `tarefa_dependencias_depende_de_fk` FOREIGN KEY (`depende_de_tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
INSERT INTO `tarefa_dependencias` (`tarefa_id`, `depende_de_tarefa_id`)
SELECT `id`, `depends_on_task_id` FROM `tarefas`
WHERE `depends_on_task_id` IS NOT NULL;
