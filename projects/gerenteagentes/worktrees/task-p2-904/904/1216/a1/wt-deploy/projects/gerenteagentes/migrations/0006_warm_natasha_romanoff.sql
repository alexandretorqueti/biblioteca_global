CREATE PROCEDURE `bg_migration_0006`()
BEGIN
  -- Remove campos de agente e ambiente de execução de projetos_captados
  -- (decisão 2026-08-24: essas informações ficam no projeto, não na tabela)

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'agente_id'
  ) THEN
    ALTER TABLE `projetos_captados` DROP COLUMN `agente_id`;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE `projetos_captados` DROP COLUMN `repo_path`;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'build_command'
  ) THEN
    ALTER TABLE `projetos_captados` DROP COLUMN `build_command`;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'unit_test_command'
  ) THEN
    ALTER TABLE `projetos_captados` DROP COLUMN `unit_test_command`;
  END IF;
END
--> statement-breakpoint
CALL `bg_migration_0006`();
--> statement-breakpoint
DROP PROCEDURE `bg_migration_0006`;
