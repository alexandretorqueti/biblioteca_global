INSERT INTO `consentimentos` (`usuario_id`, `data`, `versao_politica`, `ip`)
SELECT `u`.`id`, `u`.`created_at`, '1.0-migracao', NULL
FROM `usuarios` AS `u`
WHERE `u`.`created_at` < '2026-09-01 00:00:00'
  AND NOT EXISTS (
    SELECT 1
    FROM `consentimentos` AS `c`
    WHERE `c`.`usuario_id` = `u`.`id`
  );
