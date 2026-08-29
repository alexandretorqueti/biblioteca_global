ALTER TABLE `subtarefas`
  ADD COLUMN `workspace_path` varchar(1000),
  ADD COLUMN `workspace_branch` varchar(255),
  ADD COLUMN `workspace_base_commit` varchar(64),
  ADD COLUMN `workspace_commit_sha` varchar(64),
  ADD COLUMN `workspace_status` varchar(32),
  ADD COLUMN `workspace_created_at` timestamp NULL,
  ADD COLUMN `workspace_cleaned_at` timestamp NULL;

CREATE INDEX `idx_subtarefas_workspace_status` ON `subtarefas` (`workspace_status`);
