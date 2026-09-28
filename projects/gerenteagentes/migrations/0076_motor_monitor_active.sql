INSERT INTO `motor_configuracoes`
  (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`)
VALUES
  ('motor.monitor.active','boolean','true','true','booleano','Controla se o Monitor pode iniciar novas missões. Missões já iniciadas continuam até terminar.')
ON DUPLICATE KEY UPDATE
  `tipo` = VALUES(`tipo`),
  `valor_padrao` = VALUES(`valor_padrao`),
  `regra_validacao` = VALUES(`regra_validacao`),
  `descricao` = VALUES(`descricao`);
