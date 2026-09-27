-- Configuração opcional do deploy por projeto.
-- NULL preserva o script e a raiz de host padrão do Motor.
ALTER TABLE `projeto_motor_config`
  ADD COLUMN `deploy_script` varchar(500) NULL,
  ADD COLUMN `deploy_host_root` varchar(500) NULL;
