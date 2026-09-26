INSERT INTO prompts_versoes (prompt_id, versao, texto, contrato_versao_id, motivo, autor, validacao)
SELECT p.id, COALESCE(MAX(v.versao),0)+1,
CASE p.chave
WHEN 'dev.primeira_rodada_tarefa' THEN 'Você é o Desenvolvedor. Execute a subtarefa **NUMSUBTAREFA** — **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Workspace: **WORKSPACE**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**.\n\nFases obrigatórias: 1) leia `docs/CONTEXTO-ANALISTA.md`, a documentação e os arquivos do escopo; código e contratos vigentes prevalecem sobre resumos. 2) confirme arquivos, invariantes e dependências antes de editar. 3) implemente a mudança mínima que atende ao escopo, sem ampliar requisitos. 4) valide cada critério com comando/evidência. Não faça commit.\n\n**CONTRATOSAIDA**'
ELSE 'Retome a subtarefa **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Workspace: **WORKSPACE**. Falha anterior: **ERROGATEANTERIOR**. Leia `docs/CONTEXTO-ANALISTA.md` e o histórico da entrega antes de alterar. Preserve o que funciona, localize a causa raiz e faça somente a correção necessária. Valide novamente os critérios afetados. Não faça commit.\n\n**CONTRATOSAIDA**' END,
c.versao_ativa_id, 'Contexto transversal e execução orientada por evidência', 'sistema', JSON_OBJECT('ok',true)
FROM prompts_agentes p LEFT JOIN prompts_versoes v ON v.prompt_id=p.id JOIN prompts_contratos c ON c.chave='dev.resultado_execucao'
WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate') GROUP BY p.id,p.chave,c.versao_ativa_id;
--> statement-breakpoint
UPDATE prompts_agentes p JOIN (SELECT prompt_id,MAX(id) id FROM prompts_versoes GROUP BY prompt_id) x ON x.prompt_id=p.id JOIN prompts_versoes v ON v.id=x.id SET p.versao_ativa_id=v.id,p.conteudo=v.texto,p.status='active' WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate');
