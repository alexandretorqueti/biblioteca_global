-- Suporte a projetos independentes: o layout e os caminhos específicos do
-- projeto pertencem à configuração operacional do Motor.
ALTER TABLE `projeto_motor_config`
  ADD COLUMN `project_layout` enum('monorepo','standalone') NOT NULL DEFAULT 'monorepo',
  ADD COLUMN `repo_path_host` varchar(500) NULL,
  ADD COLUMN `git_remote` varchar(500) NULL,
  ADD COLUMN `deploy_kind` enum('blue-green-api','script','container-rebuild','manual') NOT NULL DEFAULT 'blue-green-api';
--> statement-breakpoint
-- O consoleopenclaw é o primeiro projeto cadastrado fora da Biblioteca Global.
-- O UPDATE é idempotente e mantém repo_path/branch_trabalho já cadastrados.
UPDATE `projeto_motor_config`
   SET `project_layout` = 'standalone',
       `repo_path_host` = '/home/alexandre/codigofonte/openclaw-console',
       `git_remote` = 'git@github.com:alexandretorqueti/openclaw-console.git',
       `deploy_kind` = 'script'
 WHERE `projeto_id` = 12;
