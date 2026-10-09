-- Nova classe de prompt do Monitor: monitor.verificacao_pos_deploy
-- PostDeployVerifier (motor-v3, tarefa 971): missão de verificar semanticamente
-- o batch em produção após deploy bem-sucedido.
-- Especificação: tarefa 971

-- 1) Classe do prompt (idempotente)
INSERT INTO `prompts_agentes` (`chave`, `tipo_agente`, `situacao`, `conteudo`, `origem`, `marcadores`, `ativo`, `titulo`, `descricao`, `status`)
SELECT 'monitor.verificacao_pos_deploy', 'monitor', 'verificacao_pos_deploy', '',
  'motor-v3/src/monitor/PostDeployVerifier.ts#runVerification',
  JSON_ARRAY('**BATCHID**', '**TAREFAS**', '**COMMITS**', '**TESTRUNS**', '**DIAGNOSTICOS**'),
  1, 'monitor.verificacao_pos_deploy',
  'Missão do Monitor: verificar semanticamente o batch em produção após deploy bem-sucedido (tarefa 971)',
  'active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `prompts_agentes` WHERE `chave` = 'monitor.verificacao_pos_deploy');
--> statement-breakpoint
-- 2) Versão 1 do prompt (idempotente: só insere se ainda não houver versões)
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, 1,
'## Missão — Verificação Semântica Pós-Deploy (Monitor)

Você é o verificador de qualidade pós-deploy.

### Identificação

Batch: **BATCHID**

### Contexto do batch

**TAREFAS**

### Commits do batch

**COMMITS**

### Test runs do batch

**TESTRUNS**

### Diagnósticos do deploy

**DIAGNOSTICOS**

### Objetivo

Verifique semanticamente se o batch foi implementado corretamente e está funcionando em produção. Você deve:

1. **Completude:** Tudo que foi pedido nas tarefas foi implementado?
2. **Funcionamento:** As funcionalidades estão operando corretamente em produção?
3. **Coerência dos testes:** Os testes validam os critérios de aceite corretamente? (Lesson learned: tarefas 964 e 960 passaram nos gates mas não funcionavam em produção)

### Regras

- **Somente leitura:** você pode sondar endpoints, ler logs, inspecionar estado em produção, mas NUNCA altera dados, configurações ou estado de tarefas existentes.
- **Evidência empírica:** toda finding deve ter evidência concreta (logs, responses, métricas).
- **Severidade:** classifique cada finding como high (bloqueante), medium (funcional mas incorreto) ou low (cosmético/melhoria).
- **Não crie tarefas de correção diretamente:** o PostDeployVerifier fará isso com base no seu veredito.

### Resposta obrigatória

Responda neste formato:

VEREDITO: CONSISTENTE | INCONGRUENTE | INCONCLUSIVO

## Findings

(Se INCONGRUENTE, liste cada problema encontrado)

### Tarefa: <task_id>
- Descrição: <o que está errado>
- Evidência: <sondagem empírica, logs, endpoints, responses>
- Severidade: high | medium | low

(Repita para cada tarefa com problema)

### Exemplos

**CONSISTENTE:**
```
VEREDITO: CONSISTENTE

Todas as tarefas foram implementadas corretamente. Endpoints respondem conforme especificado, testes validam os critérios de aceite, e logs não mostram erros em produção.
```

**INCONGRUENTE:**
```
VEREDITO: INCONGRUENTE

## Findings

### Tarefa: task-123
- Descrição: Endpoint /api/users não retorna o campo email conforme especificado
- Evidência: GET /api/users/1 retorna {"id":1,"name":"Test"} sem campo email. Logs mostram query SQL sem JOIN com tabela emails.
- Severidade: high

### Tarefa: task-456
- Descrição: Testes não validam o critério de aceite principal
- Evidência: Testes em src/__tests__/user.test.ts verificam apenas campos básicos, não validam filtro por data conforme critério "usuários criados nos últimos 7 dias"
- Severidade: medium
```

**INCONCLUSIVO:**
```
VEREDITO: INCONCLUSIVO

Não consegui verificar os endpoints em produção. O serviço parece estar fora do ar ou houve timeout nas requisições.
```',
  NULL,
  'Nova classe de prompt: Monitor verificador pós-deploy (tarefa 971)',
  'sistema',
  JSON_OBJECT('ok', true, 'source', '0082_postdeploy_verification_prompt')
FROM `prompts_agentes` p
WHERE p.chave = 'monitor.verificacao_pos_deploy'
  AND NOT EXISTS (SELECT 1 FROM `prompts_versoes` v WHERE v.prompt_id = p.id);
--> statement-breakpoint
-- 3) Ativa a versão e sincroniza conteúdo/marcadores na classe
UPDATE `prompts_agentes` p
JOIN (
  SELECT v.prompt_id, MAX(v.id) AS version_id
  FROM `prompts_versoes` v
  JOIN `prompts_agentes` source_prompt ON source_prompt.id = v.prompt_id
  WHERE source_prompt.chave = 'monitor.verificacao_pos_deploy'
  GROUP BY v.prompt_id
) latest ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id,
    p.status = 'active',
    p.ativo = 1,
    p.marcadores = JSON_ARRAY('**BATCHID**', '**TAREFAS**', '**COMMITS**', '**TESTRUNS**', '**DIAGNOSTICOS**'),
    p.conteudo = (SELECT texto FROM `prompts_versoes` WHERE id = latest.version_id)
WHERE p.chave = 'monitor.verificacao_pos_deploy';
