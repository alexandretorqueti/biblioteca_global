-- Uniformização de collation: utf8mb4_0900_ai_ci → utf8mb4_unicode_ci
-- Converte todas as tabelas do schema (banco) que estejam com collation utf8mb4_0900_ai_ci
-- para utf8mb4_unicode_ci, uniformizando o charset do banco do GerenteAgentes.
-- 
-- Idempotente: ALTER TABLE ... CONVERT TO CHARACTER SET é seguro para reaplicação.
-- Se a collation já for utf8mb4_unicode_ci, a operação é no-op.
-- Segura para deploy blue/green e reaplicação controlada.

-- Procedimento para converter todas as tabelas com collation utf8mb4_0900_ai_ci
SET @db_name = DATABASE();

-- Cursor implícito via prepared statement para iterar sobre todas as tabelas
SET @tables_to_convert = (
  SELECT GROUP_CONCAT(
    CONCAT('ALTER TABLE `', table_name, '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;')
    SEPARATOR '\n'
  )
  FROM information_schema.tables
  WHERE table_schema = @db_name
    AND table_collation = 'utf8mb4_0900_ai_ci'
);

-- Se houver tabelas para converter, executa dinamicamente
SET @sql = IF(
  @tables_to_convert IS NOT NULL AND @tables_to_convert != '',
  @tables_to_convert,
  'SELECT 1 AS no_tables_to_convert'
);

PREPARE convert_stmt FROM @sql;
EXECUTE convert_stmt;
DEALLOCATE PREPARE convert_stmt;

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
