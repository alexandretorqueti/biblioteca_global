DROP PROCEDURE IF EXISTS `bg_migration_0005`;--> statement-breakpoint
CREATE PROCEDURE `bg_migration_0005`()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'agentes'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_schema = DATABASE()
        AND table_name = 'projetos_captados'
        AND constraint_name = 'projetos_captados_agente_id_agentes_id_fk'
    ) THEN
      ALTER TABLE `projetos_captados`
        DROP FOREIGN KEY `projetos_captados_agente_id_agentes_id_fk`;
    END IF;

  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'projetos_captados'
      AND column_name = 'agente_id'
  ) THEN
    ALTER TABLE `projetos_captados` MODIFY COLUMN `agente_id` varchar(150);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'agentes'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'agentes'
      AND column_name = 'openclaw_agent_id'
  ) THEN
    UPDATE `projetos_captados` AS p
    LEFT JOIN `agentes` AS a
      ON a.`id` = CAST(p.`agente_id` AS UNSIGNED)
    SET p.`agente_id` = CASE
      WHEN a.`id` IS NOT NULL THEN a.`openclaw_agent_id`
      ELSE p.`agente_id`
    END
    WHERE p.`agente_id` IS NOT NULL;
  END IF;

  DROP TABLE IF EXISTS `agentes`;
END;--> statement-breakpoint
CALL `bg_migration_0005`();--> statement-breakpoint
DROP PROCEDURE `bg_migration_0005`;
