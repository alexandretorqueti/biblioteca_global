# Teardown + Piloto — Gestão de Tarefas Global (projeto_8496)

> **Status:** runbook preparado em 2026-11-02 (item #9 de `MELHORIAS-MOTOR-2026-10-29.md`).
> **Execução:** somente com autorização explícita do Alexandre e SOMENTE após o fluxo
> macro estar religado (F1 ✅ deployada em 01/11 via tarefa 1056; falta **F3 — tarefa 1058**
> deployada). Este procedimento é o piloto real do novo fluxo (= fase F5 da
> `PROPOSTA-GERACAO-MACRO-TAREFAS.md`).

## Contexto

O projeto **Gestão de Tarefas Global** (captado id 13, plataforma/banco `projeto_8496`)
nasceu do fluxo velho: as 5 tarefas macro (1021–1025) foram improvisadas pelo analista do
setup (passo 3.6), com 1 linha cada, sem dependências e com furos vs spec (multi-tenancy,
papéis/permissões, visões agrupadas, responsividade, infra de email). 1022 e 1025 ficaram
com subtarefa failed+pending. Decisão (2026-10-29): desmontar e reconstruir pelo fluxo novo
(Geração Macro: inventário REQ-* → clarificação → aprovação humana → materialização rica).

## Pré-condições (checar antes de começar)

- [ ] Tarefa **1058 (F3 — setup limpo)** deployada (fim do passo 3.6; gate `setup_status='verified'`).
- [ ] Tarefa 1056 (F1) deployada — ✅ confirmado (01/11, `deploy_request` 387).
- [ ] Motor e monitor ativos; DLQs vazias; nenhum bloqueio aberto em tarefas de outros projetos
      (janela serializada — padrão piloto 1036 de 27/10: nada mais roda durante o teardown).
- [ ] Autorização explícita do Alexandre para executar.

## Fases

### Fase 0 — Dump (irreversível só depois disto)

1. Banco: no host —
   `docker exec biblioteca-global-mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction projeto_8496' > ~/backups/projeto_8496-teardown-$(date +%Y%m%d).sql`
2. Estado das tarefas 1021–1025 (JSON completo, subtarefas/bloqueios/eventos) via API do motor:
   `GET http://<motor>/api/motor/task/<id>` para cada uma → salvar em `~/backups/teardown-8496/`.
3. Lista de commits/merges gerados pelas tarefas: `git log --oneline --grep="102[1-5]"` no repo
   (worktrees de integração + merges na base) → salvar em `teardown-8496/commits.txt`.

### Fase 1 — Tarefas antigas via API canônica

- Cancelar 1021–1025 pela API/UI canônica (Mapa de agentes). **Nunca SQL direto** nas tabelas
  do motor (invariante de conclusão — `docs/INVARIANTE-CONCLUSAO-TAREFAS.md`).

### Fase 2 — Revert do código gerado

- Reverter na `base-desenvolvimento` os merges levantados na Fase 0 (ordem: do mais recente
  para o mais antigo), preservando código que outras tarefas posteriores aproveitaram
  (decisão por diff, não por grep cego). Build + testes verdes antes do push.
- Se o revert for conflituoso demais: alternativa é deixar o código e reconstruir por cima —
  decidir com o Alexandre na hora ( registrar a decisão neste doc).

### Fase 3 — Drop do projeto

1. Remover o registro do projeto na plataforma pela via canônica de provisionamento
   (reverso de `/provision/project`; confirmar o endpoint de remoção existente na API).
2. `DROP DATABASE projeto_8496;` (somente após o dump da Fase 0 conferido).
3. Limpar referências em `projetos_captados` (captado 13) conforme o fluxo de start do novo
   processo — o captado VOLTA ao estado inicial para rodar a Geração Macro do zero.

### Fase 4 — Agente + worktrees

- Worktrees: remover `projects/gerenteagentes/.motor-v3-worktrees/task-p2-102*` (ou prefixo
  correspondente das tarefas 1021–1025) **a partir do container** (`git worktree remove/prune`
  dentro do container openclaw ou da API — **NUNCA a partir do host**: regra do namespace
  cross-container, MEMORY 2026-09-06).
- Agente dedicado do projeto (se criado no OpenClaw): desativar/remover workspace do agente.
- Containers/stack do projeto (se houver stack própria): `docker compose -p <projeto> down`
  + remover imagens — confirmar no `INFRA.md` antes.

### Fase 5 — Piloto (F5): reconstruir pelo fluxo novo

1. Spec estruturada no captado 13 (via Isa ou manualmente na descrição/clarificação).
2. `POST projetos-captados/13/start` → cria `geracoes_projeto` (status pending).
3. `ProjectGenerationWorker` roda o analista macro (inventário REQ-* + matriz de cobertura +
   Catálogo de Capacidades) → perguntas de clarificação no chat do projeto → responder.
4. Plano gerado → status `awaiting_approval` → **Alexandre aprova** (tela "Plano do projeto"
   se F2/1057 deployada, ou endpoint `POST projetos-captados/13/geracoes/:id/aprovar`).
5. Materialização das tarefas ricas (`macro-gestao-tarefas-<n>`, com dependências) →
   execução somente com `setup_status='verified'`.
6. Acompanhar pelo Mapa de agentes; smoke pós-deploy padrão (regra 2026-09-25).

## Rollback

- Até a Fase 3: nada é destrutivo (cancelamento de tarefas e reverts são revertíveis).
- Após o `DROP DATABASE`: restaurar com o dump da Fase 0
  (`mysql -uroot -p... < ~/backups/projeto_8496-teardown-*.sql`).
- Registrar neste doc: data/hora de execução, decisões tomadas, evidências (commits, dumps,
  id da nova geração) — documentação viva.
