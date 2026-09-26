-- Validação pós-importação do Administrador Global.
-- Este arquivo é somente leitura e deve ser executado pelo Motor em projeto_6241.
-- O Dashboard consulta /circulares sem filtro de ativo; circulares legadas
-- inativas não podem existir no destino porque o importador seleciona Ativo = 1.

SELECT 'clientes' AS recurso, COUNT(*) AS quantidade FROM clientes
UNION ALL
SELECT 'departamentos', COUNT(*) FROM departamentos
UNION ALL
SELECT 'config_empresa', COUNT(*) FROM config_empresa
UNION ALL
SELECT 'circulares', COUNT(*) FROM circulares;

-- Os recursos consumidos pelo CRUD genérico devem possuir dados após a carga.
SELECT CASE
  WHEN (SELECT COUNT(*) FROM clientes) > 0
   AND (SELECT COUNT(*) FROM departamentos) > 0
   AND (SELECT COUNT(*) FROM config_empresa) > 0
   AND (SELECT COUNT(*) FROM circulares) > 0
  THEN 'OK: recursos clientes, departamentos, empresa e circulares possuem dados'
  ELSE 'FALHA: recurso esperado sem dados'
END AS validacao_recursos;

-- Nenhum filho importado pode apontar para um cliente inexistente.
SELECT COUNT(*) AS responsaveis_orfaos
FROM responsaveis r
LEFT JOIN clientes c ON c.id = r.cliente_id
WHERE c.id IS NULL;

SELECT COUNT(*) AS contratos_orfaos
FROM contratos ct
LEFT JOIN clientes c ON c.id = ct.cliente_id
WHERE c.id IS NULL;

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM responsaveis r
    LEFT JOIN clientes c ON c.id = r.cliente_id
    WHERE c.id IS NULL
  )
   AND NOT EXISTS (
    SELECT 1
    FROM contratos ct
    LEFT JOIN clientes c ON c.id = ct.cliente_id
    WHERE c.id IS NULL
  )
  THEN 'OK: relacionamentos de responsáveis e contratos íntegros'
  ELSE 'FALHA: existem relacionamentos órfãos'
END AS validacao_relacionamentos;

-- O importador não cria usuários locais nem relaciona administrador_id;
-- qualquer valor existente ainda deve apontar para um usuário local válido.
SELECT COUNT(*) AS administradores_orfaos
FROM clientes c
LEFT JOIN usuarios u ON u.id = c.administrador_id
WHERE c.administrador_id IS NOT NULL AND u.id IS NULL;

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM clientes c
    LEFT JOIN usuarios u ON u.id = c.administrador_id
    WHERE c.administrador_id IS NOT NULL AND u.id IS NULL
  )
  THEN 'OK: administrador_id nulo ou vinculado a usuário local existente'
  ELSE 'FALHA: administrador_id aponta para usuário inexistente'
END AS validacao_administradores;

-- Sem coluna ativo em circulares, a tela só consegue exibir o conjunto
-- materializado nesta tabela. Registros exibíveis devem ter título e conteúdo.
SELECT COUNT(*) AS circulares_invalidas_para_dashboard
FROM circulares
WHERE TRIM(titulo) = '' OR TRIM(conteudo) = '';

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM circulares
    WHERE TRIM(titulo) = '' OR TRIM(conteudo) = ''
  )
  THEN 'OK: todas as circulares materializadas são exibíveis pelo Dashboard'
  ELSE 'FALHA: circular sem título ou conteúdo'
END AS validacao_dashboard;
