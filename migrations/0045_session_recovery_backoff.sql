-- Backoff configurável entre recuperações transitórias de sessão.
INSERT INTO motor_configuracoes (chave, tipo, valor, valor_padrao, regra_validacao, descricao)
VALUES ('motor.session_recovery_backoff_ms','number','30000','30000','inteiro entre 0 e 300000','Espera inicial entre recuperações transitórias de sessão; dobra a cada tentativa até cinco minutos.')
ON DUPLICATE KEY UPDATE descricao = VALUES(descricao), regra_validacao = VALUES(regra_validacao);
