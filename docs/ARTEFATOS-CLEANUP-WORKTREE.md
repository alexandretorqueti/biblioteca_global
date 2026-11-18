# Salvaguarda de artefatos no cleanup de worktrees

## Causa raiz

Após uma conclusão ser promovida, o resultado de deploy bem-sucedido passa por
`receiveResult` → `cleanupWorktrees` → `GitWorktreePreparer.cleanup`. O cleanup
removia cada worktree com `git worktree remove --force` e, ao final, removia
`{MOTOR_WORKTREE_ROOT}/{taskId}` recursivamente. Arquivos criados durante a
execução, mas nunca commitados na branch da subtarefa (por exemplo, um
runbook), não faziam parte de nenhum commit e eram destruídos sem registro.
O resultado persistido podia sobreviver, mas apontava para esse caminho morto.

## Salvaguarda

Antes de remover cada worktree, o motor executa `git status --porcelain` (com
arquivos não rastreados expandidos). Se houver arquivos modificados ou não
rastreados, cada arquivo existente é copiado preservando seu caminho relativo
para:

```text
{MOTOR_WORKTREE_ROOT}/.motor-artifacts/<taskId>/<worktree-relativo>/...
```

A cópia ocorre antes de `git worktree remove --force` e antes da remoção de
`taskRoot`. O relatório de cleanup contém o worktree, a raiz persistente e os
caminhos finais vivos. `DeployConsumer` grava esse relatório no log da operação
e emite um alerta estruturado com a tarefa, worktree e caminhos recuperados.

Falhas de cópia são incluídas no mesmo relatório e alertadas/logadas como erro;
o cleanup continua best-effort e não altera o status já concluído do deploy.
Worktrees limpos não criam `.motor-artifacts`, não geram alerta e mantêm o
fluxo anterior.
