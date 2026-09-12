INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(v.versao), 0) + 1,
  CONCAT(
    '## Missão de Recuperação do Motor\n\nVocê é o agente responsável por diagnosticar e tentar resolver um bloqueio real do Motor-v2.\n\n',
    '### Identificação\n\nTarefa: **IDTAREFA**\nSubtarefa: **IDSUBTAREFA**\nWorkspace autorizado: **WORKSPACE**\nTentativa atual: **TENTATIVA**\n\n',
    '### Bloqueio identificado\n\nMotivo:\n**MOTIVOBLOQUEIO**\n\nComando que falhou:\n**COMANDO**\n\nEvidência:\n**EVIDENCIA**\n\n',
    '### Objetivo\n\nInvestigue a causa do bloqueio no workspace autorizado e tente corrigir o problema para permitir a execução normal da subtarefa.\n\n',
    '### Procedimento obrigatório\n\n1. Inspecione o estado atual do workspace e os arquivos relacionados ao erro.\n2. Confirme se o bloqueio é causado por código ou configuração do projeto; comando, teste ou dependência; estado inconsistente do Motor; ambiente local; ou recurso externo indisponível.\n3. Se a causa puder ser corrigida dentro do escopo autorizado, implemente a correção mínima necessária.\n4. Execute novamente o comando que falhou ou um teste equivalente que comprove a correção.\n5. Verifique se a correção não introduziu falhas relacionadas.\n6. Deixe as alterações salvas no workspace para que a subtarefa possa ser retomada.\n\n',
    '### Restrições\n\n- Trabalhe somente no workspace autorizado.\n- Preserve o objetivo original da tarefa.\n- Não faça push.\n- Não altere a branch base.\n- Não altere configurações globais do OpenClaw, Gateway, Docker ou infraestrutura compartilhada.\n- Não contorne testes, gates ou validações.\n- Não declare o bloqueio resolvido sem evidência de validação.\n- Se depender de uma ação externa ou de infraestrutura fora do escopo, não invente uma correção: registre exatamente o que precisa ser feito.\n\n',
    '### Resposta obrigatória\n\nResponda neste formato:\n\nSTATUS: RESOLVIDO | PARCIALMENTE_RESOLVIDO | NAO_RESOLVIDO\n\nCAUSA:\n<causa técnica confirmada>\n\nCORREÇÃO:\n<alterações realizadas ou “nenhuma”>\n\nVALIDAÇÃO:\n<comandos executados e resultados>\n\nRETOMADA:\n<o que deve ser executado na próxima tentativa>\n\nBLOQUEIO_REMANESCENTE:\n<descreva o impedimento restante ou “nenhum”>'
  ),
  NULL,
  'Publicar missão completa de recuperação de bloqueios pelo Monitor',
  'sistema',
  JSON_OBJECT('ok', true, 'source', '0035_monitor_recovery_prompt')
FROM `prompts_agentes` p
LEFT JOIN `prompts_versoes` v ON v.prompt_id = p.id
WHERE p.chave = 'monitor.correcao_motor'
GROUP BY p.id;
--> statement-breakpoint
UPDATE `prompts_agentes` p
JOIN (
  SELECT v.prompt_id, MAX(v.id) AS version_id
  FROM `prompts_versoes` v
  JOIN `prompts_agentes` source_prompt ON source_prompt.id = v.prompt_id
  WHERE source_prompt.chave = 'monitor.correcao_motor'
  GROUP BY v.prompt_id
) latest ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id,
    p.status = 'active',
    p.marcadores = JSON_ARRAY('**IDTAREFA**', '**IDSUBTAREFA**', '**WORKSPACE**', '**TENTATIVA**', '**MOTIVOBLOQUEIO**', '**COMANDO**', '**EVIDENCIA**'),
    p.conteudo = (SELECT texto FROM `prompts_versoes` WHERE id = latest.version_id)
WHERE p.chave = 'monitor.correcao_motor';
