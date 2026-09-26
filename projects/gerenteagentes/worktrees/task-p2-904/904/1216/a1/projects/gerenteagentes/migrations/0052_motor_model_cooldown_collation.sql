-- Uniformiza a collation usada na seleção de modelos do projeto. A tabela do
-- catálogo v3 nasceu com o default do MySQL 8 (utf8mb4_0900_ai_ci), enquanto
-- project_model_selection usa utf8mb4_unicode_ci.
ALTER TABLE `motor_model_cooldown`
  MODIFY COLUMN `model` varchar(200)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
