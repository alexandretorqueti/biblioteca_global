-- O contrato do analista é um protocolo do Motor. A versão 2 continha um
-- exemplo vazio e um schema reduzido, o que não ensinava a estrutura interna
-- de coverage ao agente (incidente task-p2-780).
INSERT INTO `prompts_contratos_versoes` (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_OBJECT(
    'oneOf', JSON_ARRAY(
      JSON_OBJECT(
        'type', 'object',
        'required', JSON_ARRAY('subtarefas', 'requirements', 'coverage'),
        'properties', JSON_OBJECT(
          'subtarefas', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('seq', 'titulo', 'scope', 'acceptance_criteria', 'deliverables', 'requirements_covered', 'depends_on'))),
          'requirements', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('id', 'description'))),
          'coverage', JSON_OBJECT('type', 'array', 'minItems', 1, 'items', JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('requirement', 'covered_by')))
        )
      ),
      JSON_OBJECT('type', 'object', 'required', JSON_ARRAY('kind', 'resumo', 'perguntas'))
    )
  ),
  JSON_OBJECT(
    'subtarefas', JSON_ARRAY(JSON_OBJECT(
      'seq', 1,
      'titulo', 'Persistir dados e validar migração',
      'scope', 'Criar a persistência necessária e validar a migração no banco do projeto.',
      'acceptance_criteria', JSON_ARRAY('Migration aplicada sem erro', 'Dados persistidos podem ser lidos'),
      'deliverables', JSON_ARRAY('migration', 'teste de persistência'),
      'requirements_covered', JSON_ARRAY('REQ-1'),
      'depends_on', JSON_ARRAY()
    )),
    'requirements', JSON_ARRAY(JSON_OBJECT('id', 'REQ-1', 'description', 'Persistência do recurso')),
    'coverage', JSON_ARRAY(JSON_OBJECT('requirement', 'REQ-1', 'covered_by', JSON_ARRAY(1)))
  ),
  'Responda somente com JSON. Um plano exige subtarefas detalhadas e os campos requirements e coverage. Cada subtarefa exige seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered e depends_on. Identifique todos os requisitos como REQ-* e cubra cada um na matriz. Em coverage use exatamente {"requirement":"REQ-1","covered_by":[1]}; não use requirement_id nem subtarefas.',
  'Contrato completo e exemplo estrutural do plano do analista', 'sistema'
FROM `prompts_contratos` c
LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'analista.plano_ou_perguntas'
GROUP BY c.id;
--> statement-breakpoint
UPDATE `prompts_contratos` c
JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest ON latest.contrato_id = c.id
SET c.versao_ativa_id = latest.version_id
WHERE c.chave = 'analista.plano_ou_perguntas';
--> statement-breakpoint
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id,
  (SELECT COALESCE(MAX(v.versao), 0) + 1 FROM `prompts_versoes` v WHERE v.prompt_id = p.id),
  active.texto,
  contract.versao_ativa_id,
  'Vincular contrato completo do analista', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
JOIN `prompts_versoes` active ON active.id = p.versao_ativa_id
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao');
--> statement-breakpoint
UPDATE `prompts_agentes` p
JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao');
