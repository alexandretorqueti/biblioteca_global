INSERT INTO `motor_configuracoes` (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`)
VALUES ('deploy_drain_threshold_minutes','number','45','45','inteiro >= 0; 0 desabilita','Idade mínima de pedido de deploy pendente elegível para pausar o início de novas análises e execuções.')
ON DUPLICATE KEY UPDATE
  `tipo` = VALUES(`tipo`),
  `valor_padrao` = VALUES(`valor_padrao`),
  `regra_validacao` = VALUES(`regra_validacao`),
  `descricao` = VALUES(`descricao`);
