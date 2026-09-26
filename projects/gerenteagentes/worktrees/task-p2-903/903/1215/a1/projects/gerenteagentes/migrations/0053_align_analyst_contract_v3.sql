-- Publica uma assinatura única para tela de Prompts, prompt enviado e parser
-- do Motor v3. O exemplo não pode usar arrays vazios: ele ensina ao analista
-- a estrutura interna efetivamente exigida.
INSERT INTO `prompts_contratos_versoes`
  (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_OBJECT(
    'oneOf', JSON_ARRAY(
      JSON_OBJECT(
        'type', 'object',
        'required', JSON_ARRAY('subtarefas', 'requirements', 'coverage', 'estrategia'),
        'properties', JSON_OBJECT(
          'subtarefas', JSON_OBJECT(
            'type', 'array', 'minItems', 1,
            'items', JSON_OBJECT(
              'type', 'object',
              'required', JSON_ARRAY('seq', 'titulo', 'scope', 'acceptance_criteria', 'deliverables', 'requirements_covered', 'depends_on'),
              'properties', JSON_OBJECT(
                'seq', JSON_OBJECT('type', 'integer'),
                'titulo', JSON_OBJECT('type', 'string'),
                'scope', JSON_OBJECT('type', 'string'),
                'acceptance_criteria', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'string')),
                'deliverables', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'string')),
                'requirements_covered', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'string')),
                'depends_on', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT('type', 'integer'))
              )
            )
          ),
          'requirements', JSON_OBJECT(
            'type', 'array', 'minItems', 1,
            'items', JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('id', 'description'),
              'properties', JSON_OBJECT('id', JSON_OBJECT('type', 'string'), 'description', JSON_OBJECT('type', 'string')))
          ),
          'coverage', JSON_OBJECT(
            'type', 'array', 'minItems', 1,
            'items', JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('requirement', 'covered_by'),
              'properties', JSON_OBJECT(
                'requirement', JSON_OBJECT('type', 'string'),
                'covered_by', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'integer'))
              ))
          ),
          'estrategia', JSON_OBJECT(
            'type', 'object',
            'required', JSON_ARRAY('invariantes', 'artefatos_compartilhados', 'ordem_de_execucao'),
            'properties', JSON_OBJECT(
              'invariantes', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT('type', 'string')),
              'artefatos_compartilhados', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT('type', 'string')),
              'ordem_de_execucao', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT('type', 'integer'))
            ))
        )
      ),
      JSON_OBJECT(
        'type', 'object', 'required', JSON_ARRAY('kind', 'resumo', 'perguntas'),
        'properties', JSON_OBJECT(
          'kind', JSON_OBJECT('type', 'string'),
          'resumo', JSON_OBJECT('type', 'string'),
          'perguntas', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'string'))
        ))
    )),
  JSON_OBJECT(
    'subtarefas', JSON_ARRAY(JSON_OBJECT(
      'seq', 1, 'titulo', 'Alterar comportamento',
      'scope', 'Aplicar a alteração solicitada no arquivo identificado.',
      'acceptance_criteria', JSON_ARRAY('Comportamento solicitado validado'),
      'deliverables', JSON_ARRAY('Código alterado', 'Teste automatizado'),
      'requirements_covered', JSON_ARRAY('REQ-1'), 'depends_on', JSON_ARRAY())),
    'requirements', JSON_ARRAY(JSON_OBJECT('id', 'REQ-1', 'description', 'Comportamento solicitado')),
    'coverage', JSON_ARRAY(JSON_OBJECT('requirement', 'REQ-1', 'covered_by', JSON_ARRAY(1))),
    'estrategia', JSON_OBJECT(
      'invariantes', JSON_ARRAY('Preservar comportamentos existentes'),
      'artefatos_compartilhados', JSON_ARRAY('Arquivo e teste afetados'),
      'ordem_de_execucao', JSON_ARRAY(1))),
  'Responda somente com um objeto JSON que siga exatamente o JSON Schema e o exemplo fornecidos. Não renomeie campos. Use seq e depends_on numéricos; requirements usa description; coverage é um array de objetos com requirement e covered_by. Para esclarecimentos, use kind="perguntas", resumo e perguntas.',
  'Alinhar tela, prompt, resposta e parser do Motor v3', 'sistema'
FROM `prompts_contratos` c
LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'analista.plano_ou_perguntas'
GROUP BY c.id;
--> statement-breakpoint
UPDATE `prompts_contratos` c
JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest
  ON latest.contrato_id = c.id
SET c.versao_ativa_id = latest.version_id
WHERE c.chave = 'analista.plano_ou_perguntas';
--> statement-breakpoint
INSERT INTO `prompts_versoes`
  (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(all_versions.versao), 0) + 1, active.texto,
       contract.versao_ativa_id, 'Alinhar contrato completo ao Motor v3', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
JOIN `prompts_versoes` active ON active.id = p.versao_ativa_id
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
LEFT JOIN `prompts_versoes` all_versions ON all_versions.prompt_id = p.id
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao')
GROUP BY p.id, active.texto, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p
JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest
  ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao');
