ALTER TABLE `prompts_execucoes`
  ADD COLUMN `prompt_final` text NULL,
  ADD COLUMN `composicao_json` json NULL;
