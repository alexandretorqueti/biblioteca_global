ALTER TABLE `tarefa_contextos_execucao`
  MODIFY COLUMN `fase` ENUM('analysis', 'development', 'baseline_fix') NOT NULL;
