CREATE PROCEDURE `bg_migration_0003`()
BEGIN
  -- 1) FK tarefas.agente_id (removida manualmente do estado parcial do
  -- projeto_640 — DDL do MySQL não é transacional). Sem efeito se ausente.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'tarefas'
      AND constraint_name = 'tarefas_agente_id_agentes_id_fk'
  ) THEN
    ALTER TABLE `tarefas` DROP FOREIGN KEY `tarefas_agente_id_agentes_id_fk`;
  END IF;

  -- 2) Colunas de ambiente de execução em projetos_captados.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE `projetos_captados` ADD `repo_path` text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'build_command'
  ) THEN
    ALTER TABLE `projetos_captados` ADD `build_command` varchar(500);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projetos_captados' AND column_name = 'unit_test_command'
  ) THEN
    ALTER TABLE `projetos_captados` ADD `unit_test_command` varchar(500);
  END IF;

  -- 3) Colunas removidas de tarefas.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'tarefas' AND column_name = 'agente_id'
  ) THEN
    ALTER TABLE `tarefas` DROP COLUMN `agente_id`;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'tarefas' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE `tarefas` DROP COLUMN `repo_path`;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'tarefas' AND column_name = 'build_command'
  ) THEN
    ALTER TABLE `tarefas` DROP COLUMN `build_command`;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'tarefas' AND column_name = 'unit_test_command'
  ) THEN
    ALTER TABLE `tarefas` DROP COLUMN `unit_test_command`;
  END IF;

  -- Nota: a FK self-ref subtarefas.depends_on_subtask_id (criada em
  -- 0002_brief_sue_storm) não é declarada no schema.ts (drizzle não gera FK
  -- de self-ref por .references()). O diff do drizzle-kit emitia um DROP
  -- FOREIGN KEY spurious neste arquivo — removido manualmente para manter
  -- banco e snapshot consistentes. (Mesmo padrão da correção de
  -- 0002_oval_iron_fist.)
END
--> statement-breakpoint
CALL `bg_migration_0003`();
--> statement-breakpoint
DROP PROCEDURE `bg_migration_0003`;

