# Contexto do Analista — TáQui

Projeto `taqui`, controle multi-condomínio de encomendas. Fontes: `schema.ts`, `config.ts`, `migrations/`, `screens/` e documentação do Motor sobre setup/config lint.

## Domínio

Cadastros: condomínios, unidades, moradores, proprietários, funcionários e transportadoras. Operação: encomendas, confirmação e entrega. Há relações hierárquicas condomínio→unidades→moradores e telas customizadas para registro, notificações e portaria.

## Regras de análise

Confirme `config.ts`, schema e implementações em `screens/` antes de planejar. Para qualquer tela `kind: custom`, valide `componentId`, registro no front e endpoint/ação correspondente. Mudanças de banco exigem migration.

## Registro confirmado por tarefa

_Contexto inicial curado em 2026-09-13._
