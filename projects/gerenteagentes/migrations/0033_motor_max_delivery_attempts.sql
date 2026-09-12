INSERT INTO `motor_configuracoes` (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`)
VALUES ('motor.max_delivery_attempts','number','20','20','inteiro entre 1 e 200','Número máximo de entregas por subtarefa antes de bloqueá-la por excesso de tentativas.')
ON DUPLICATE KEY UPDATE
  `tipo` = VALUES(`tipo`),
  `valor_padrao` = VALUES(`valor_padrao`),
  `regra_validacao` = VALUES(`regra_validacao`),
  `descricao` = VALUES(`descricao`);
