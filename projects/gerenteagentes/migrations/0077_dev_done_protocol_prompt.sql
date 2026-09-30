-- O prompt inicial de desenvolvimento usa o protocolo ::DONE:: interpretado
-- pelo WorkerLauncher. Ele não pode carregar o contrato JSON legado, pois os
-- dois protocolos são mutuamente exclusivos.
INSERT INTO `prompts_versoes`
  (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT
  p.id,
  COALESCE(MAX(v.versao), 0) + 1,
  'Você é o Desenvolvedor responsável por executar a sua parte da tarefa.\n\nOBJETIVO GERAL — Tarefa: **TITULOTAREFA**\nDescrição da tarefa (o que deve ser feito no geral): **DESCRICAOTAREFA**\n\nSUA PARTE — Subtarefa **NUMSUBTAREFA**: **TITULOSUBTAREFA**\nEspecificação da sua parte (escopo): **ESCOPO**\nCritérios de aceite: **CRITERIOSACEITE**\nWorkspace: **WORKSPACE**\n\nA descrição da tarefa define o objetivo geral; o escopo e os critérios da sua subtarefa definem exatamente a parte sob sua responsabilidade. Use a descrição para entender o contexto e não conflitar com o restante do trabalho, mas implemente apenas a sua parte: não antecipe, não refaça e não altere o que pertence a outras subtarefas.\n\nFases obrigatórias: 1) leia `docs/CONTEXTO-ANALISTA.md`, a documentação e os arquivos do escopo; código e contratos vigentes prevalecem sobre resumos. 2) confirme arquivos, invariantes e dependências antes de editar. 3) implemente a mudança mínima que atende ao escopo, sem ampliar requisitos. 4) valide cada critério com comando/evidência. Não faça commit.\n\n***\nUse as ferramentas do openclaw para realizar as operações em arquivos, sempre que possível.\nAo finalizar responda apenas com ::DONE::\n***',
  NULL,
  'Substituir contrato JSON incompatível pelo protocolo ::DONE:: do worker DEV',
  'sistema',
  JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
LEFT JOIN `prompts_versoes` v ON v.prompt_id = p.id
WHERE p.chave = 'dev.primeira_rodada_tarefa'
  AND NOT EXISTS (
    SELECT 1
    FROM `prompts_versoes` existing
    WHERE existing.prompt_id = p.id
      AND existing.motivo = 'Substituir contrato JSON incompatível pelo protocolo ::DONE:: do worker DEV'
  )
GROUP BY p.id;
--> statement-breakpoint

UPDATE `prompts_agentes` p
JOIN (
  SELECT v.prompt_id, MAX(v.id) AS version_id
  FROM `prompts_versoes` v
  JOIN `prompts_agentes` prompt ON prompt.id = v.prompt_id
  WHERE prompt.chave = 'dev.primeira_rodada_tarefa'
    AND v.motivo = 'Substituir contrato JSON incompatível pelo protocolo ::DONE:: do worker DEV'
  GROUP BY v.prompt_id
) latest ON latest.prompt_id = p.id
JOIN `prompts_versoes` v ON v.id = latest.version_id
SET p.versao_ativa_id = v.id,
    p.conteudo = v.texto,
    p.status = 'active'
WHERE p.chave = 'dev.primeira_rodada_tarefa';
