-- Restaura a descrição da tarefa no prompt do desenvolvedor e separa
-- explicitamente o objetivo geral (tarefa) da especificação da parte (subtarefa).
-- Regressão corrigida: a migration 0039 republicou o prompt sem a máscara
-- **DESCRICAOTAREFA**, então o DEV deixou de receber a descrição da tarefa em
-- todo caso curto (<= 12000 caracteres), quando o Motor não envia a mensagem
-- separada com a descrição.
INSERT INTO prompts_versoes (prompt_id, versao, texto, contrato_versao_id, motivo, autor, validacao)
SELECT p.id, COALESCE(MAX(v.versao),0)+1,
'Você é o Desenvolvedor responsável por executar a sua parte da tarefa.\n\nOBJETIVO GERAL — Tarefa: **TITULOTAREFA**\nDescrição da tarefa (o que deve ser feito no geral): **DESCRICAOTAREFA**\n\nSUA PARTE — Subtarefa **NUMSUBTAREFA**: **TITULOSUBTAREFA**\nEspecificação da sua parte (escopo): **ESCOPO**\nCritérios de aceite: **CRITERIOSACEITE**\nWorkspace: **WORKSPACE**\n\nA descrição da tarefa define o objetivo geral; o escopo e os critérios da sua subtarefa definem exatamente a parte sob sua responsabilidade. Use a descrição para entender o contexto e não conflitar com o restante do trabalho, mas implemente apenas a sua parte: não antecipe, não refaça e não altere o que pertence a outras subtarefas.\n\nFases obrigatórias: 1) leia `docs/CONTEXTO-ANALISTA.md`, a documentação e os arquivos do escopo; código e contratos vigentes prevalecem sobre resumos. 2) confirme arquivos, invariantes e dependências antes de editar. 3) implemente a mudança mínima que atende ao escopo, sem ampliar requisitos. 4) valide cada critério com comando/evidência. Não faça commit.\n\n**CONTRATOSAIDA**',
c.versao_ativa_id, 'Restaurar descrição da tarefa e separar objetivo geral x escopo da subtarefa', 'sistema', JSON_OBJECT('ok',true)
FROM prompts_agentes p
LEFT JOIN prompts_versoes v ON v.prompt_id=p.id
JOIN prompts_contratos c ON c.chave='dev.resultado_execucao'
WHERE p.chave='dev.primeira_rodada_tarefa'
GROUP BY p.id, c.versao_ativa_id;
--> statement-breakpoint
UPDATE prompts_agentes p
JOIN (SELECT prompt_id, MAX(id) id FROM prompts_versoes GROUP BY prompt_id) x ON x.prompt_id=p.id
JOIN prompts_versoes v ON v.id=x.id
SET p.versao_ativa_id=v.id, p.conteudo=v.texto, p.status='active'
WHERE p.chave='dev.primeira_rodada_tarefa';
