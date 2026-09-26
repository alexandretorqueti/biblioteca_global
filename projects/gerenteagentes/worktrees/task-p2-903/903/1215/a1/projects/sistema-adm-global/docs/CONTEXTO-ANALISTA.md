# Contexto do Analista — Administrador Global

Projeto `sistema-adm-global` da Biblioteca Global. Fonte de dados: `schema.ts`; interface: `config.ts`; telas específicas: `screens/`; evolução de banco: `migrations/`.

## Domínio e interface

Gestão administrativa com dashboard e hubs customizados, clientes e contatos do site, circulares, RH e configurações administrativas. A configuração declara telas customizadas e CRUDs; cada `componentId` custom precisa existir no registry/tela correspondente.

## Regras de análise

Leia `config.ts` e `schema.ts` antes do plano; valide efeitos em telas customizadas e em CRUDs. Para alterações de dados, crie migration versionada e preserve os contratos da plataforma.

## Registro confirmado por tarefa

_Contexto inicial curado em 2026-09-13._
