-- Limites configuráveis para evitar duplicação e corte silencioso da descrição.
INSERT INTO motor_configuracoes (chave, tipo, valor, valor_padrao, regra_validacao, descricao)
VALUES
('motor.prompt_description_embed_max_chars','number','12000','12000','inteiro entre 1000 e 100000','Tamanho máximo da descrição embutida no prompt; acima disso é enviada em mensagem separada.'),
('motor.prompt_description_context_max_chars','number','30000','30000','inteiro entre 1000 e 100000','Tamanho máximo da descrição enviada na mensagem de contexto separada.')
ON DUPLICATE KEY UPDATE descricao = VALUES(descricao), regra_validacao = VALUES(regra_validacao);
