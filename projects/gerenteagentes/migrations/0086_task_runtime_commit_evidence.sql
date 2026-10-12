-- Evidência permanente dos commits que representam a integração da tarefa.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN `integration_commit_sha` varchar(64) NULL,
  ADD COLUMN `base_commit_sha` varchar(64) NULL,
  ADD COLUMN `merge_commit_sha` varchar(64) NULL;
--> statement-breakpoint

-- Recupera a evidência já persistida no pedido de deploy para tarefas antigas.
UPDATE `task_runtime_facts` f
INNER JOIN `deploy_requests` d ON d.tarefa_id = f.tarefa_id
SET f.integration_commit_sha = d.requested_commit
WHERE f.integration_commit_sha IS NULL
  AND d.requested_commit IS NOT NULL;
