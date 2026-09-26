# Runbook de Recuperação — Motor v2

Procedimentos para recuperar estados presos sem reinventar o que foi feito
manualmente na tarefa #727 (integração manual, reset de `workspace_status`,
desbloqueio de tarefa). Ferramenta: `npm run recover` (após `npm run build`),
que roda `dist/scripts/recover.js`. Todas as operações são **idempotentes** e
aceitam `--dry-run` para simular sem gravar.

A conexão usa as variáveis `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/
`MYSQL_PASSWORD` (mesmas do motor). Dentro do container `biblioteca-global-api`
elas já estão presentes.

## Diagnóstico rápido

```bash
node dist/scripts/recover.js status
```

Mostra, nesta ordem:
1. tarefas bloqueadas (`tarefas.status = 'blocked'`);
2. subtarefas bloqueadas e o `workspace_status` de cada uma;
3. integrações pendentes (`workspace_status = 'integration_failed'`) com branch e commit;
4. últimos 15 registros de `bloqueios` (motivo + evidência);
5. leases ativos em `execution_resources` (com expiração).

## Cenário 1 — falha de integração (workspace_status = integration_failed)

Sintoma: a subtarefa passou no gate, o commit existe, mas o merge na
branch-base falhou (conflito, repositório sujo, branch ausente). A tarefa fica
`blocked` com o motivo em `resultado`.

**Opção A — deixar o motor integrar de novo** (quando a causa já foi removida,
ex.: repositório sujo foi limpo):

```bash
node dist/scripts/recover.js integrate --subtarefa <id> --dry-run
node dist/scripts/recover.js integrate --subtarefa <id>
```

O comando reexecuta o mesmo `GitWorkspaceManager.integrate` da produção
(checkout limpo, commit esperado, `--no-ff`), grava `workspace_status =
'integrated'` e devolve a tarefa `blocked -> ready` para o próximo pump.

**Opção B — merge manual** (quando há conflito que precisa de decisão humana):

```bash
git -C <repo_path> switch <branch_trabalho>
git -C <repo_path> merge --no-ff motor-v2/<tarefa>/<subtarefa>/<tentativa>
# resolver conflitos, commitar
node dist/scripts/recover.js mark-integrated --subtarefa <id>
```

`mark-integrated` só atualiza o banco (assume que o merge foi feito e
conferido). A tarefa volta a `ready` se estava bloqueada.

## Cenário 2 — bloqueio ambiental ou de configuração

Sintoma: `bloqueios` com `blocked_environment` (repo ausente, git
indisponível) ou `systemic_failure` (configuração operacional faltando).
A subtarefa está `blocked` e a tarefa também.

1. Corrigir a causa (caminho do repo, `repo_path`/`branch_trabalho`/
   `build_command`/`unit_test_command` no `projeto_motor_config`).
2. Desbloquear:

```bash
node dist/scripts/recover.js unblock --tarefa <id> --dry-run
node dist/scripts/recover.js unblock --tarefa <id>
```

O comando devolve subtarefas `blocked -> pending` e a tarefa `blocked ->
ready` (ou `planned` se ainda não tem plano). O próximo pump retoma.

## Cenário 3 — worktree órfão / workspace preso

Sintoma: subtarefa com `workspace_status = 'active'` antigo e sem worker
rodando (o `status` acima mostra os leases; reconciler já converte tarefas
órfãs). O worktree fica em `MOTOR_WORKSPACE_ROOT/<tarefa>/<subtarefa>/<tentativa>`.

1. Confirmar que não há worker: `GET /api/motor/stats` (workers ativos).
2. Remover o worktree manualmente no host:
   `git -C <repo_path> worktree remove --force <caminho>`.
3. Se a subtarefa ficou presa em `running`/`verifying`, o reconciler de
   expiração devolve para `pending` quando o lease expira (até 120s após a
   expiração do lease). Para acelerar: `unblock --tarefa <id>` cobre apenas
   estados `blocked`; para `running` preso, aguardar o reconciler.

## Cenário 4 — rollback do rollout (motor-v2 → v1)

Ver `docs/rollback-rollout.md`. Resumo: remover `MOTOR_VERSION=v2` do
ambiente da API da Biblioteca e reiniciar; o v2 só acrescentou colunas, não há
migração reversa obrigatória.

## Regras de segurança

- Sempre `--dry-run` antes da operação real.
- Nunca editar `subtarefas.status`/`tarefas.status` à mão quando o recover
  cobre o caso — ele mantém os campos auxiliares (`resultado`, `updated_at`)
  consistentes.
- Após qualquer recuperação, acompanhar com `GET /api/motor/stats` e
  `node dist/scripts/recover.js status` até o estado estabilizar.
