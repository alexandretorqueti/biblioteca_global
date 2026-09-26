-- Uniformização de collation: utf8mb4_0900_ai_ci → utf8mb4_unicode_ci
-- Converte todas as tabelas do schema (banco) que estejam com collation utf8mb4_0900_ai_ci
-- para utf8mb4_unicode_ci, uniformizando o charset do banco do GerenteAgentes.
-- 
-- Idempotente: ALTER TABLE ... CONVERT TO CHARACTER SET é seguro para reaplicação.
-- Se a collation já for utf8mb4_unicode_ci, a operação é no-op.
-- Segura para deploy blue/green e reaplicação controlada.

-- Procedimento para converter todas as tabelas com collation utf8mb4_0900_ai_ci
SET @db_name = DATABASE();

-- Criar procedimento armazenado para iterar sobre as tabelas
DROP PROCEDURE IF EXISTS convert_collation;

DELIMITER $$

CREATE PROCEDURE convert_collation()
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE table_name_var VARCHAR(255);
    DECLARE cur CURSOR FOR 
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = @db_name 
        AND table_collation = 'utf8mb4_0900_ai_ci';
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
    
    OPEN cur;
    
    read_loop: LOOP
        FETCH cur INTO table_name_var;
        IF done THEN
            LEAVE read_loop;
        END IF;
        
        SET @sql = CONCAT('ALTER TABLE `', table_name_var, '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END LOOP;
    
    CLOSE cur;
END$$

DELIMITER ;

-- Executar o procedimento
CALL convert_collation();

-- Remover o procedimento
DROP PROCEDURE IF EXISTS convert_collation;

-- Verificação pós-conversão: lista tabelas ainda com collation errada (deve retornar vazio)
SELECT 
  table_name,
  table_collation,
  'Ainda com collation utf8mb4_0900_ai_ci - verificar manualmente' AS status
FROM information_schema.tables
WHERE table_schema = @db_name
  AND table_collation = 'utf8mb4_0900_ai_ci';

-- Confirmação: lista tabelas agora com collation correta
SELECT 
  COUNT(*) AS total_tables_utf8mb4_unicode_ci
FROM information_schema.tables
WHERE table_schema = @db_name
  AND table_collation = 'utf8mb4_unicode_ci';
