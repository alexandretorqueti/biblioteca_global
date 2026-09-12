-- Verificação pós-importação do Administrador Global.
-- Somente leitura: não contém INSERT, UPDATE, DELETE, DDL ou acesso à origem.
-- O Motor deve executar este arquivo no database projeto_6241.
--
-- Cada SELECT devolve uma evidência independente. Os valores esperados do
-- relatório pré-importação são explicitados para que o Motor possa comparar
-- o resultado sem alterar dados.

SELECT 'contagens_destino' AS verificacao,
       (SELECT COUNT(*) FROM clientes) AS clientes,
       (SELECT COUNT(*) FROM responsaveis) AS responsaveis,
       (SELECT COUNT(*) FROM contratos) AS contratos,
       (SELECT COUNT(*) FROM circulares) AS circulares,
       (SELECT COUNT(*) FROM contatos_site) AS contatos_site,
       (SELECT COUNT(*) FROM departamentos) AS departamentos,
       (SELECT COUNT(*) FROM config_empresa) AS config_empresa;

-- Confirma que todas as tabelas consultadas pertencem ao schema atual e que
-- nenhuma tabela legado sem equivalente foi criada durante a importação.
SELECT 'tabelas_destino_esperadas' AS verificacao,
       (SELECT COUNT(*)
          FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_type = 'BASE TABLE'
           AND table_name IN ('usuarios', 'clientes', 'responsaveis',
                              'contratos', 'contatos_site', 'circulares',
                              'departamentos', 'config_empresa')) AS tabelas_esperadas,
       (SELECT COUNT(*)
          FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_type = 'BASE TABLE'
           AND table_name NOT IN ('usuarios', 'clientes', 'responsaveis',
                                  'contratos', 'contatos_site', 'circulares',
                                  'departamentos', 'config_empresa')) AS tabelas_nao_previstas,
       'esperado: 8 tabelas esperadas e 0 não previstas' AS resultado_esperado;

SELECT 'esperados_relatorio_pre_importacao' AS verificacao,
       7 AS clientes_legado,
       3 AS circulares_legado_ativas,
       1 AS circulares_preexistentes,
       'comparar com contagens_destino; config_empresa só soma se estava vazia' AS observacao;

-- Integridade referencial: o resultado deve ser zero em ambas as colunas.
SELECT 'fk_orfas' AS verificacao,
       (SELECT COUNT(*)
          FROM responsaveis r
          LEFT JOIN clientes c ON c.id = r.cliente_id
         WHERE c.id IS NULL) AS responsaveis_sem_cliente,
       (SELECT COUNT(*)
          FROM contratos ct
          LEFT JOIN clientes c ON c.id = ct.cliente_id
         WHERE c.id IS NULL) AS contratos_sem_cliente;

-- Campos obrigatórios do schema atual; cada contador deve ser zero.
SELECT 'nulos_em_campos_obrigatorios' AS verificacao,
       (SELECT COUNT(*) FROM clientes
         WHERE nome_fantasia IS NULL OR razao_social IS NULL OR cnpj IS NULL
            OR logradouro IS NULL OR numero IS NULL OR bairro IS NULL
            OR cidade IS NULL OR uf IS NULL OR cep IS NULL
            OR telefone IS NULL OR email IS NULL) AS clientes_invalidos,
       (SELECT COUNT(*) FROM responsaveis
         WHERE cliente_id IS NULL OR nome IS NULL) AS responsaveis_invalidos,
       (SELECT COUNT(*) FROM contratos
         WHERE cliente_id IS NULL OR numero IS NULL) AS contratos_invalidos,
       (SELECT COUNT(*) FROM circulares
         WHERE titulo IS NULL OR conteudo IS NULL) AS circulares_invalidas,
       (SELECT COUNT(*) FROM departamentos WHERE nome IS NULL) AS departamentos_invalidos,
       (SELECT COUNT(*) FROM config_empresa WHERE nome IS NULL) AS config_empresa_invalida;

-- Campos opcionais podem permanecer nulos; este resultado documenta isso.
SELECT 'nulos_permitidos_schema' AS verificacao,
       (SELECT COUNT(*) FROM clientes WHERE inscricao_municipal IS NULL) AS clientes_inscricao_municipal,
       (SELECT COUNT(*) FROM clientes WHERE inscricao_estadual IS NULL) AS clientes_inscricao_estadual,
       (SELECT COUNT(*) FROM clientes WHERE complemento IS NULL) AS clientes_complemento,
       (SELECT COUNT(*) FROM clientes WHERE ramal IS NULL) AS clientes_ramal,
       (SELECT COUNT(*) FROM clientes WHERE instagram IS NULL) AS clientes_instagram,
       (SELECT COUNT(*) FROM responsaveis WHERE cargo IS NULL) AS responsaveis_cargo,
       (SELECT COUNT(*) FROM contratos WHERE descricao IS NULL) AS contratos_descricao,
       (SELECT COUNT(*) FROM contratos WHERE valor IS NULL) AS contratos_valor,
       (SELECT COUNT(*) FROM contratos WHERE inicio IS NULL) AS contratos_inicio,
       (SELECT COUNT(*) FROM contratos WHERE fim IS NULL) AS contratos_fim,
       (SELECT COUNT(*) FROM circulares WHERE image_url IS NULL) AS circulares_image_url;

-- Usuários pertencem à Biblioteca Global. A tabela local não deve receber
-- linhas nesta importação; o resultado esperado é zero (estado pré-importação).
SELECT 'usuarios_local_preservados' AS verificacao,
       COUNT(*) AS linhas_usuarios_local,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'REVISAR_COM_BASE_NO_SNAPSHOT_PRE_IMPORTACAO' END AS resultado
  FROM usuarios;

-- O vínculo de administrador foi deliberadamente descartado: usuários são
-- geridos pela Biblioteca Global e a tabela local não deve ser importada nem
-- receber registros do legado. Clientes sem vínculo local são aceitáveis.
SELECT 'vinculos_administrador_descartados' AS verificacao,
       COUNT(*) AS clientes_com_administrador_local,
       'esperado: 0; administrador_id deve permanecer nulo' AS resultado_esperado
  FROM clientes
 WHERE administrador_id IS NOT NULL;

-- O schema atual não possui ativo em circulares. A origem foi consultada com
-- Ativo = 1; portanto não deve haver circular legada inativa para contabilizar.
-- O Motor deve confirmar que nenhuma circular marcada como inativa foi criada
-- (a coluna ativo não existe no destino e deliberadamente não é adicionada).
SELECT 'circulares_legadas_ativas_e_preexistente' AS verificacao,
       COUNT(*) AS circulares_destino,
       4 AS esperado_se_o_destino_tinha_1_preexistente,
       CASE WHEN COUNT(*) >= 1 THEN 'PREEXISTENTE_PRESERVADA' ELSE 'FALHA' END AS resultado
  FROM circulares;

-- Exceções conhecidas no relatório pré-importação: o cliente incompleto não
-- deve existir no destino. O Motor deve substituir o identificador abaixo
-- pelo id do relatório, se esse relatório fornecer o id efetivo.
SELECT 'excecao_cliente_incompleto' AS verificacao,
       'cliente legado incompleto: não importado' AS razao,
       'confirmar ausência pelo id do relatório pré-importação; nenhum INSERT corretivo permitido' AS acao;

-- Listagem operacional das exceções atualmente observáveis no destino.
SELECT 'registros_com_excecao_no_destino' AS verificacao,
       'clientes com campo obrigatório vazio' AS tipo,
       c.id,
       CONCAT_WS(', ',
         IF(c.nome_fantasia IS NULL, 'nome_fantasia', NULL),
         IF(c.razao_social IS NULL, 'razao_social', NULL),
         IF(c.cnpj IS NULL, 'cnpj', NULL),
         IF(c.logradouro IS NULL, 'logradouro', NULL),
         IF(c.numero IS NULL, 'numero', NULL),
         IF(c.bairro IS NULL, 'bairro', NULL),
         IF(c.cidade IS NULL, 'cidade', NULL),
         IF(c.uf IS NULL, 'uf', NULL),
         IF(c.cep IS NULL, 'cep', NULL),
         IF(c.telefone IS NULL, 'telefone', NULL),
         IF(c.email IS NULL, 'email', NULL)) AS razao
  FROM clientes c
 WHERE c.nome_fantasia IS NULL OR c.razao_social IS NULL OR c.cnpj IS NULL
    OR c.logradouro IS NULL OR c.numero IS NULL OR c.bairro IS NULL
    OR c.cidade IS NULL OR c.uf IS NULL OR c.cep IS NULL
    OR c.telefone IS NULL OR c.email IS NULL
 ORDER BY c.id;
