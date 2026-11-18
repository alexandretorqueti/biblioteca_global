# Salvaguarda de artefatos no cleanup de worktrees

## Causa raiz

Após uma conclusão ser promovida, o resultado de deploy bem-sucedido passa por
`receiveResult` → `cleanupWorktrees` → `GitWorktreePreparer.cleanup`. O cleanup
removia cada worktree com `git worktree remove --force` e, ao final, removia
`{MOTOR_WORKTREE_ROOT}/{taskId}` recursivamente. Arquivos criados durante a
execução, mas nunca commitados na branch da subtarefa (por exemplo, um
runbook), não faziam parte de nenhum commit e eram destruídos sem registro.
O resultado persistido podia sobreviver, mas apontava para esse caminho morto.

## Incidente de referência — 2026-11-18

Na tarefa `1078/isas-mt-06`, subtarefa `1493` (`completion_kind=external_operation`),
o resultado citava `docs/billing/SANDBOX-E2E-RUNBOOK.md`. O arquivo existia apenas
como não rastreado no worktree `.motor-v3-worktrees/isas-mt-06/1493/a1`; não havia
commit correspondente em `git log --all`. O cleanup removeu o worktree e o
artefato foi perdido permanentemente, deixando a referência do resultado apontar
para um caminho morto. Este caso é a razão para as duas salvaguardas abaixo:
o caminho resgatado passa a ser anotado no evento persistente da subtarefa e a
checagem de `external_operation` rejeita a classificação de persistente para um
arquivo apenas untracked ou modificado no worktree.

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

## Mapa de remoção e salvaguardas

Os pontos de remoção no motor-v3 são:

- `DeployConsumer.cleanupWorktrees` → `GitWorktreePreparer.cleanup`: cleanup
  pós-deploy bem-sucedido. Antes de `git worktree remove --force` e de remover
  a raiz da tarefa, `salvageDirtyWorktree` copia alterações para
  `.motor-artifacts/<taskId>/<subtaskId>/<tentativa>/...`. O `DeployConsumer`
  mantém o operation log, emite `console.warn` e grava
  `subtask.artifacts_salvaged` no `TaskEventSink`, com `artifactPath` real.
- `GitWorktreePreparer.prepareIntegration` e `prepareNamedWorktree`: a fase de
  preparo da subtarefa remove resíduos de integração/worktrees anteriores. Os
  mesmos relatórios de salvage são propagados em `artifactSalvage`, registrados
  por `SubtaskExecutionConsumer.logWorktreeRecoveries` e alertados antes da
  remoção.
- `SubtaskExecutionConsumer` (conclusão e recuperação de sessão): para
  `external_operation`, caminhos relativos são resolvidos no worktree e
  verificados com `git status --porcelain`. Um arquivo citado que esteja
  untracked ou modificado localmente é tratado como não persistente; um arquivo
  commitado no HEAD/em qualquer ref ou fora do worktree segue sem alerta.
  A checagem é best-effort e nunca reverte a conclusão nem cria retry.

### Convenção e códigos observáveis

O diretório persistente segue a convenção
`.motor-artifacts/<taskId>/<subtaskId>/<tentativa>/` sob a raiz de worktrees,
preservando o caminho relativo do arquivo. Os códigos usados são:

- `artifact_salvaged` / `artifact_salvage_failed` no operation log de deploy;
- eventos `worktree_artifact_salvaged` / `worktree_artifact_salvage_failed` no
  console e `subtask.artifacts_salvaged` no registro persistente da tarefa;
- `external_operation_missing_artifact` quando o caminho citado não existe;
- `external_operation_non_persistent_artifact` quando existe somente como
  untracked/modificado no worktree;
- `external_operation_artifact_check_failed` quando a checagem best-effort não
  consegue inspecionar o caminho.

Nos dois últimos casos de alerta, o resultado operacional também é registrado
como evento `subtask.external_artifact_alert`, e o `humanNotifier` é acionado.
