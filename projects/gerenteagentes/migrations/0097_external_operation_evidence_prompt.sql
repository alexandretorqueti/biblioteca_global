-- external_operation não pode ser concluída com ::DONE:: seco.
-- O Motor valida os dois campos no pós-processamento; este texto orienta tanto
-- o prompt persistido ativo quanto clientes que usam o fallback do worker.
UPDATE prompts_agentes p
JOIN prompts_versoes v ON v.id = p.versao_ativa_id
SET v.texto = CONCAT(
      v.texto,
      '\n\nClassificação da subtarefa (completion_kind): **COMPLETION_KIND**',
      '\nSe completion_kind for external_operation, a operação não exige diff Git, mas a resposta final deve conter evidência estruturada antes de ::DONE:::',
      '\nO que foi feito: <ação externa executada>',
      '\nComo verificar: <passos, comando, URL, estado ou outro critério observável>.',
      '\n::DONE:: sozinho é inválido para external_operation e será recusado para retry.'
    ),
    p.conteudo = CONCAT(
      p.conteudo,
      '\n\nClassificação da subtarefa (completion_kind): **COMPLETION_KIND**',
      '\nSe completion_kind for external_operation, a operação não exige diff Git, mas a resposta final deve conter evidência estruturada antes de ::DONE:::',
      '\nO que foi feito: <ação externa executada>',
      '\nComo verificar: <passos, comando, URL, estado ou outro critério observável>.',
      '\n::DONE:: sozinho é inválido para external_operation e será recusado para retry.'
    )
WHERE p.chave = 'dev.primeira_rodada_tarefa'
  AND v.texto NOT LIKE '%external_operation%O que foi feito%';
