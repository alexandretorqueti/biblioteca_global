-- Nova classe de prompt do Monitor: monitor.resolucao_bloqueio
-- Monitor-Resolvedor de Bloqueios (motor-v3): missão de investigar, corrigir e
-- desbloquear tarefas bloqueadas, com acesso total (branch do dev, integração e base).
-- Especificação: gerenteagentes/docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md

-- 1) Classe do prompt (idempotente)
INSERT INTO `prompts_agentes` (`chave`, `tipo_agente`, `situacao`, `conteudo`, `origem`, `marcadores`, `ativo`, `titulo`, `descricao`, `status`)
SELECT 'monitor.resolucao_bloqueio', 'monitor', 'resolucao_bloqueio', '',
  'motor-v3/src/monitor/MonitorResolutionConsumer.ts#buildMission',
  JSON_ARRAY('**IDTAREFA**', '**TITULOTAREFA**', '**IDSUBTAREFA**', '**REPOSITORIO**', '**BRANCHBASE**', '**BRANCHDEV**', '**BRANCHINTEGRACAO**', '**WORKSPACE**', '**MOTIVOBLOQUEIO**', '**COMANDO**', '**EVIDENCIA**'),
  1, 'monitor.resolucao_bloqueio',
  'Missão do Monitor-Resolvedor: investigar a causa do bloqueio, corrigir (dev, testes ou motor) e desbloquear a tarefa (motor-v3)',
  'active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `prompts_agentes` WHERE `chave` = 'monitor.resolucao_bloqueio');
--> statement-breakpoint
-- 2) Versão 1 do prompt (idempotente: só insere se ainda não houver versões)
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, 1,
'## Missão — Resolução de Bloqueio (Monitor)

Você é o resolvedor de problemas das tarefas.

### Identificação

Tarefa: **IDTAREFA** — **TITULOTAREFA**
Subtarefa: **IDSUBTAREFA**
Repositório: **REPOSITORIO**
Branch base: **BRANCHBASE**
Branch do dev: **BRANCHDEV**
Branch de integração: **BRANCHINTEGRACAO**
Workspace da tarefa: **WORKSPACE**

### Bloqueio identificado

Motivo:
**MOTIVOBLOQUEIO**

Comando que falhou:
**COMANDO**

Evidência:
**EVIDENCIA**

### Objetivo

Analise por que a tarefa foi bloqueada e, ao descobrir a causa, identifique a origem do problema e siga o fluxo correspondente. Você tem acesso total: pode olhar e mexer na branch do dev, na branch de integração e até na pasta base, se for necessário.

### Fluxo de resolução

1. Investigue a causa raiz do bloqueio: código, logs, testes, migrations, estado do motor e do banco.
2. Classifique a origem do problema e aja:

**A) Erro do dev (e ele pode resolver):** você resolve o código dele na branch do dev, roda os testes para validar, deixa a branch pronta e desbloqueia a tarefa para ela seguir seu curso.

**B) Testes do desenvolvedor não rodando:** corrija o que impede os testes de rodar (código ou testes), valide executando-os e desbloqueie a tarefa.

**C) Erro causado pelo motor:**
   a. Crie uma branch a partir da base;
   b. Resolva o problema do motor nessa branch;
   c. Crie os testes se necessário;
   d. Mergeie para a base;
   e. Devolva a branch para a base;
   f. Rode o script de deploy;
   g. Após a correção do motor, volte à tarefa que ficou travada, resolva o problema dela e desbloqueie. Se você achar melhor deixar o motor (com o novo código) resolver o problema da tarefa sozinho, apenas desbloqueie a tarefa e deixe seguir o curso.

### Regras

- Não contorne testes, gates ou validações para “passar”.
- Nunca declare resolução sem evidência de validação (comandos executados e resultados).
- Toda resolução deve gerar uma mensagem para o chat da tarefa explicando o que era o problema e como você resolveu.
- Se o problema depender de ação externa (infraestrutura, credenciais, aprovação humana), não invente correção: informe exatamente o que é necessário e mantenha o bloqueio.

### Resposta obrigatória

Responda neste formato:

STATUS: RESOLVIDO | PARCIALMENTE_RESOLVIDO | NAO_RESOLVIDO
ORIGEM: DEV | TESTES_DEV | MOTOR | EXTERNO

CAUSA:
<causa técnica confirmada>

CORREÇÃO:
<alterações realizadas, branches e commits afetados, ou “nenhuma”>

VALIDAÇÃO:
<comandos executados e resultados>

DEPLOY:
<script de deploy executado e resultado, ou “não se aplica”>

RETOMADA:
<o que a tarefa/o motor deve fazer em seguida>

MENSAGEM_CHAT:
<mensagem para o chat da tarefa explicando o que era o problema e como foi resolvido>',
  NULL,
  'Nova classe de prompt: Monitor-Resolvedor de bloqueios de tarefas (acesso total, correção de dev/testes/motor)',
  'sistema',
  JSON_OBJECT('ok', true, 'source', '0065_monitor_resolucao_bloqueio_prompt')
FROM `prompts_agentes` p
WHERE p.chave = 'monitor.resolucao_bloqueio'
  AND NOT EXISTS (SELECT 1 FROM `prompts_versoes` v WHERE v.prompt_id = p.id);
--> statement-breakpoint
-- 3) Ativa a versão e sincroniza conteúdo/marcadores na classe
UPDATE `prompts_agentes` p
JOIN (
  SELECT v.prompt_id, MAX(v.id) AS version_id
  FROM `prompts_versoes` v
  JOIN `prompts_agentes` source_prompt ON source_prompt.id = v.prompt_id
  WHERE source_prompt.chave = 'monitor.resolucao_bloqueio'
  GROUP BY v.prompt_id
) latest ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id,
    p.status = 'active',
    p.ativo = 1,
    p.marcadores = JSON_ARRAY('**IDTAREFA**', '**TITULOTAREFA**', '**IDSUBTAREFA**', '**REPOSITORIO**', '**BRANCHBASE**', '**BRANCHDEV**', '**BRANCHINTEGRACAO**', '**WORKSPACE**', '**MOTIVOBLOQUEIO**', '**COMANDO**', '**EVIDENCIA**'),
    p.conteudo = (SELECT texto FROM `prompts_versoes` WHERE id = latest.version_id)
WHERE p.chave = 'monitor.resolucao_bloqueio';
