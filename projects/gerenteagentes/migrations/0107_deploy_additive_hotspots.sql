-- Seed: fusão determinística de hotspots aditivos no composeBatch (tarefa
-- motor-hotspot-merge-deterministico). Deploys atrasaram 4-12h (18-19/11) por
-- conflito de cherry-pick em arquivos de registro onde cada tarefa apenas
-- ADICIONA linhas (app.module.ts, registry.ts, api-client index.ts,
-- customScreens.test.tsx). A feature fica DESLIGADA por padrão
-- (deterministic_hotspot_merge='false'); ligar somente após testes de paridade.
INSERT INTO `motor_configuracoes` (`chave`, `tipo`, `valor`, `valor_padrao`, `regra_validacao`, `descricao`)
VALUES (
  'deploy_additive_hotspots',
  'string',
  JSON_ARRAY(
    'apps/api/src/app.module.ts',
    'projects/biblioteca-global/screens/registry.ts',
    'packages/api-client/src/index.ts',
    'apps/web/src/project/registry/__tests__/customScreens.test.tsx'
  ),
  JSON_ARRAY(
    'apps/api/src/app.module.ts',
    'projects/biblioteca-global/screens/registry.ts',
    'packages/api-client/src/index.ts',
    'apps/web/src/project/registry/__tests__/customScreens.test.tsx'
  ),
  'json array de caminhos relativos à raiz do repositório',
  'Arquivos de registro aditivos onde o composeBatch pode fundir conflitos puramente aditivos de forma determinística (tarefa motor-hotspot-merge-deterministico)'
)
ON DUPLICATE KEY UPDATE `descricao` = VALUES(`descricao`), `updated_at` = NOW();
--> statement-breakpoint
INSERT INTO `motor_configuracoes` (`chave`, `tipo`, `valor`, `valor_padrao`, `regra_validacao`, `descricao`)
VALUES (
  'deterministic_hotspot_merge',
  'boolean',
  'false',
  'false',
  'booleano',
  'Ativa a fusão determinística de hotspots aditivos no composeBatch; desligada, o isolamento de membro conflitante segue idêntico ao comportamento anterior (tarefa motor-hotspot-merge-deterministico)'
)
ON DUPLICATE KEY UPDATE `descricao` = VALUES(`descricao`), `updated_at` = NOW();
