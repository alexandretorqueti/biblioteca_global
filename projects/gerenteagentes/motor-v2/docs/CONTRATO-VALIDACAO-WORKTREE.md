# Contrato de validação e diagnóstico de worktrees

Status: contrato operacional do Motor-v2 (subtarefas e integração).

Este contrato define o que o Motor deve verificar antes de entregar um
worktree a qualquer fase que leia ou escreva Git. A validação é feita no
container do Motor, usando o `repoPath` e os caminhos que o próprio Motor
resolveu; um caminho válido em outro container não é evidência suficiente.

## Invariantes

Para cada worktree de subtarefa e para o worktree de integração da tarefa:

1. O caminho existe, é absoluto e é o worktree selecionado pelo Motor.
2. O ponteiro `.git` (arquivo ou diretório) resolve para um gitdir existente e
   acessível no namespace do container do Motor. A saída de
   `git -C <worktree> rev-parse --git-dir` deve ser resolvível a partir desse
   mesmo container; não se aceita ponteiro exclusivo de `/data/...` quando o
   Motor opera em `/home/alexandre/...`, nem o inverso.
3. `git -C <worktree> rev-parse --show-toplevel` retorna a raiz Git esperada.
   Para monorepos, o `repoPath` pode ser um projeto abaixo dessa raiz, mas
   nunca pode ficar fora dela.
4. `git -C <worktree> branch --show-current` retorna a branch esperada:
   `motor-v2/<tarefa>/<subtarefa>/a<N>` para subtarefa ou
   `motor-v2/<tarefa>/integracao` para integração.
5. As três leituras são feitas no mesmo caminho, no mesmo preflight, antes de
   `captureIntegrationBaseline()`, gates, integração ou qualquer operação do
   agente. Uma validação parcial não aprova o workspace.

## Sequência mínima de validação

O executor deve executar, nesta ordem, todos os comandos abaixo a partir do
worktree (equivalente a `git -C`):

```text
git -C <worktree> rev-parse --git-dir
git -C <worktree> rev-parse --show-toplevel
git -C <worktree> branch --show-current
```

As saídas devem ser normalizadas apenas por trim para comparação. O `gitdir`
deve ser convertido em caminho absoluto relativo ao worktree quando a saída
for relativa. A raiz retornada deve ser comparada após `resolve()`, sem
confundir o diretório do projeto com a raiz do monorepo.

## Diagnóstico observável

Toda decisão deve carregar uma evidência estruturada, sem depender de
reconstruir informação a partir de uma mensagem de exceção:

```json
{
  "kind": "subtask|integration",
  "worktreePath": "/caminho/visivel-no-container-do-motor",
  "repoPath": "/repositorio-usado-pelo-motor",
  "gitDir": "/gitdir-resolvido-ou-alvo-do-ponteiro",
  "expectedRoot": "/raiz-git-esperada",
  "actualRoot": "/raiz-git-retornada-ou-null",
  "expectedBranch": "motor-v2/task/subtask/a1",
  "actualBranch": "branch-retornada-ou-vazia",
  "checks": {
    "gitDir": "passed|failed",
    "topLevel": "passed|failed",
    "branch": "passed|failed"
  },
  "classification": "valid|recoverable|unrecoverable",
  "reasonCode": "worktree_invalid_namespace|worktree_gitdir_missing|worktree_root_mismatch|worktree_branch_mismatch|worktree_git_unavailable",
  "message": "motivo legível com os caminhos envolvidos"
}
```

`actualRoot`, `actualBranch` e `gitDir` podem ser `null` quando o comando não
produziu saída. O diagnóstico deve informar o caminho do worktree, o gitdir
apontado (ou o alvo que falhou), `repoPath`, raiz/branch esperadas e a saída
sanitizada do Git; nunca registrar segredos.

## Classificação e recuperação

- `valid`: os três comandos executaram, o gitdir existe no namespace do
  Motor, a raiz é a esperada e a branch coincide.
- `recoverable`: falha de resolução do Git causada por ponteiro inexistente,
  gitdir ausente ou namespace divergente, identificada antes de qualquer
  entrega. O Motor pode executar, de forma idempotente, `git worktree repair
  <worktree>` a partir de `repoPath` (e `git worktree prune` quando aplicável)
  e repetir a validação completa. O reparo não é falha do agente nem consome
  tentativa.
- `unrecoverable`: o reparo falhou, o repositório-fonte não é utilizável, a
  raiz continua divergente ou a branch continua incorreta. O Motor bloqueia
  com `blocked_environment` e motivo `worktree_invalid_namespace` (ou o
  código específico acima), citando todos os caminhos e a ação de reparo
  executada. Não encaminha o agente para outra cópia do repositório.

Falhas de branch esperada, raiz Git incompatível e Git indisponível não devem
ser mascaradas como sucesso. Conflito, sujeira do repositório ou gate vermelho
não são falhas de namespace e não entram na autorrecuperação deste contrato.

## Aplicação por tipo de workspace

| Workspace | Raiz esperada | Branch esperada | Pontos mínimos de validação |
| --- | --- | --- | --- |
| Subtarefa | `git rev-parse --show-toplevel` do worktree da tentativa | `motor-v2/<tarefa>/<subtarefa>/a<N>` | criação, `phasePrepare`, antes de gates e entrega |
| Integração | `git rev-parse --show-toplevel` do worktree da tarefa | `motor-v2/<tarefa>/integracao` | criação/reuso, `captureIntegrationBaseline()`, merge e promoção |

O `repoPath` do projeto pode apontar para `projects/<slug>` dentro da raiz
retornada. O `worktreePath` é a raiz usada pelos comandos Git; o
`projectPath` é o subdiretório entregue ao agente.

## Namespace canônico

O Motor deve gravar e aceitar somente ponteiros resolvíveis no namespace do
container onde executa. A alternativa de infraestrutura recomendada é criar
um symlink-espelho no container da API, por exemplo
`/data/workspace/projects/codigofonte -> /home/alexandre/codigofonte`, para que
ambos os namespaces também resolvam os mesmos gitdirs. Essa alternativa é
apenas recomendação: este contrato não altera compose, configuração de
container nem arquivos do OpenClaw.

Metadados de worktree são responsabilidade exclusiva do Motor. Agentes não
devem executar `git worktree repair`, `prune` ou `remove` no repositório
compartilhado; caso precisem de uma operação, ela deve ser exposta pelo Motor.
