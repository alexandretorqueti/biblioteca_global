INSERT INTO `motor_configuracoes`
  (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`)
VALUES
  ('motor.active','boolean','true','true','booleano','Controla se o Motor pode iniciar novas atividades. Atividades já iniciadas continuam até o próximo ponto de despacho.')
ON DUPLICATE KEY UPDATE
  `tipo` = VALUES(`tipo`),
  `valor_padrao` = VALUES(`valor_padrao`),
  `regra_validacao` = VALUES(`regra_validacao`),
  `descricao` = VALUES(`descricao`);
