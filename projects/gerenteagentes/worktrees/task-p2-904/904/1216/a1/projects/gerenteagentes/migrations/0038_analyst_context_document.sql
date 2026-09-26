-- Contexto transversal do Analista: a fonte persistida prevalece sobre o fallback.
INSERT INTO prompts_versoes (prompt_id, versao, texto, contrato_versao_id, motivo, autor, validacao)
SELECT p.id, COALESCE(MAX(v.versao), 0) + 1,
  CASE p.chave
    WHEN 'analista.primeira_rodada_tarefa' THEN
      '## Missão estruturada do Analista\n\nTarefa: **TITULOTAREFA**\nTipo: **TIPOTAREFA**\nWorkspace autorizado: **WORKSPACE**\n\n### 1. Contexto\nLeia primeiro `docs/CONTEXTO-ANALISTA.md` dentro do workspace autorizado. Ele é o índice inicial; para cada área afetada, siga seus documentos-fonte e confirme no código, contratos e testes vigentes. Não trate o resumo como substituto da fonte de verdade.\n\n### 2. Investigação\nLeia a documentação operacional aplicável, incluindo `AGENTS.md`, `TOOLS.md`, `INFRA.md`, README e runbooks. Diferencie fato verificado, hipótese e decisão pendente. Não conclua indisponibilidade por ausência em `127.0.0.1` ou no worktree sem confirmar host, container, porta e namespace.\n\n### 3. Análise e plano\nDescrição integral: **DESCRICAOTAREFA**\n\nPreserve requisitos, etapas e definição de pronto. Localize antes os arquivos, contratos, testes, invariantes e dependências reais. Planeje contratos, dados e verificadores antes de orquestração e interface. Se faltar decisão de produto, escopo ou autorização, faça perguntas objetivas; não invente um plano.\n\n### 4. Contexto transversal\nDurante esta análise, não edite a branch base nem grave fatos não confirmados no contexto. Na revisão final, registre apenas decisões e mudanças estruturais confirmadas na seção da tarefa de `docs/CONTEXTO-ANALISTA.md`, na branch de integração.\n\n**CONTRATOSAIDA**'
    ELSE
      '## Retomada estruturada do Analista\n\nTarefa: **TITULOTAREFA**\nWorkspace autorizado: **WORKSPACE**\nDescrição integral: **DESCRICAOTAREFA**\nHistórico de clarificação: **HISTORICOCLARIFICACAO**\n\nLeia novamente `docs/CONTEXTO-ANALISTA.md` e as fontes aplicáveis antes de replanejar. Não repita perguntas respondidas. Confirme no código e contratos o impacto das respostas; diferencie fatos, hipóteses e decisões pendentes. Quando estiver claro, devolva plano completo e verificável; caso contrário, faça perguntas objetivas.\n\n**CONTRATOSAIDA**'
  END,
  CASE WHEN p.chave IN ('analista.primeira_rodada_tarefa','analista.retomada_apos_clarificacao') THEN (SELECT versao_ativa_id FROM prompts_contratos WHERE chave='analista.plano_ou_perguntas') ELSE NULL END,
  'Contexto transversal e workspace explícito do Analista', 'sistema', JSON_OBJECT('ok', true)
FROM prompts_agentes p LEFT JOIN prompts_versoes v ON v.prompt_id=p.id
WHERE p.chave IN ('analista.primeira_rodada_tarefa','analista.retomada_apos_clarificacao')
GROUP BY p.id, p.chave;
--> statement-breakpoint
UPDATE prompts_agentes p
JOIN (SELECT prompt_id, MAX(id) id FROM prompts_versoes GROUP BY prompt_id) latest ON latest.prompt_id=p.id
JOIN prompts_versoes v ON v.id=latest.id
SET p.versao_ativa_id=v.id, p.conteudo=v.texto, p.status='active', p.marcadores=JSON_ARRAY('**TITULOTAREFA**','**TIPOTAREFA**','**DESCRICAOTAREFA**','**HISTORICOCLARIFICACAO**','**WORKSPACE**')
WHERE p.chave IN ('analista.primeira_rodada_tarefa','analista.retomada_apos_clarificacao');
