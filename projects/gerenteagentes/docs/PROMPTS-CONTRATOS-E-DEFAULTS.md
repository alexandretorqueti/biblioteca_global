# Prompts, contratos de saída e defaults

## Fontes e precedência

1. Uma execução usa a versão publicada no banco, vinculada a uma versão imutável de contrato.
2. Sem versão publicada ou sem banco, o Motor usa o snapshot TypeScript versionado.
3. Se o snapshot ainda não tiver a chave, usa o catálogo embarcado original.

O contrato é injetado por `**CONTRATOSAIDA**`. Textos legados sem essa máscara recebem as instruções ao final automaticamente.

## Ambiente novo

O entrypoint executa, antes do Motor:

```sh
npm run db:migrate:gerenteagentes
npm run db:bootstrap:gerenteagentes
```

O bootstrap é idempotente: cria somente registros ausentes e nunca substitui uma versão já publicada.

## Tornar versões locais o default do produto

Depois de publicar e validar os prompts/contratos na tela, execute na raiz:

```sh
npm run prompts:export-defaults
```

O comando lê apenas versões ativas, gera `motor-v2/src/prompts/prompt-defaults.generated.ts` e não faz commit. Revise o diff, rode typecheck/testes e versione o arquivo. A partir desse commit, o mesmo conteúdo passa a ser o fallback sem banco e o bootstrap de instalações novas.

Migrations históricas nunca são reescritas. Mudanças de estrutura recebem nova migration; mudanças de conteúdo entram no snapshot canônico versionado.
