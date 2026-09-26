# Limpeza de concluídos — escopo e contrato de evidências

Subtarefa 1 da automação **Limpeza de Concluídos**. Este documento define a
seleção, a classificação das evidências e a ordem da execução. Não executa
alterações no banco.

## Escopo

Selecionar somente linhas de `tarefas` com `tipo = 'desenvolvimento'` cujo
status calculado, conforme `docs/STATUS-DERIVADO-DE-TAREFAS.md`, seja
`completed`. O valor legado/materializado de `tarefas.status` não participa da
seleção e não pode ser escrito.

As fontes compartilhadas da seleção e da auditoria são:

- `tarefas` e `projetos_captados`: identidade, tipo, projeto e repositório;
- `task_runtime_facts`: integração confirmada e terminais administrativos;
- `subtarefas`: todas em `verified` ou `superseded`;
- `deploy_requests`: histórico de deploy e exclusão de itens já sucedidos;
- Git do `repo_path`: branch `motor-v2/<task-id>/integracao` ancestral à
  `branch_trabalho`.

Uma tarefa só pode ser confirmada quando a consulta derivada indicar
`completed`, não existir `deploy_requests.status = 'succeeded'`, a integração
estiver confirmada, todas as subtarefas forem aprovadas e o Git provar a
ancestralidade da branch de integração na branch base. A automação posterior
persistirá o fato histórico em `deploy_requests`; nunca atualizará
`tarefas.status`.

A seleção deve ser feita pelo calculador canônico de status (equivalente a
`deriveTaskStatus(facts) = 'completed'`), e não por `tarefas.status`. Em termos
de fatos mínimos, a consulta deve restringir `t.tipo = 'desenvolvimento'`,
`integration_confirmed_at IS NOT NULL`, todas as subtarefas em
`('verified', 'superseded')`, ausência de terminal administrativo, pausa,
clarificação pendente e subtarefa ativa/bloqueada, além de excluir qualquer
`deploy_requests.status = 'succeeded'`. O caso de deploy falho só entra quando
o calculador também retornar `completed`; o valor textual de qualquer coluna
materializada não substitui esse cálculo.

## Contrato de classificação

- **candidato confirmado**: todos os requisitos de seleção e evidência Git são
  satisfeitos, sem conflito histórico. Elegível para persistir
  `deploy_requests.status = 'succeeded'` de forma idempotente.
- **candidato ambíguo**: falta uma evidência necessária ou ela não pode ser
  resolvida (por exemplo, repositório/branch inexistente, base indeterminada ou
  estado factual incompleto). Não alterar.
- **conflito**: há evidência explícita incompatível ou que não pode ser
  sobrescrita com segurança (por exemplo, solicitação histórica
  `failed`, bloqueio ativo ou divergência entre fatos e Git). Não alterar;
  registrar o conflito para decisão posterior.
- **fora do escopo**: `tipo` diferente de `desenvolvimento` ou status derivado
  diferente de `completed`, incluindo tarefas ainda pendentes, bloqueadas,
  falhas administrativas ou já `deployed`.

`deploy_requests.status = 'succeeded'` é fonte histórica de deploy: linhas
assim são idempotentemente excluídas da seleção e nunca duplicadas nem
alteradas.

## Snapshot de candidatos

Consulta realizada em 2026-09-12 UTC no banco `projeto_640`, usando os fatos
derivados e sem considerar `tarefas.status`. O Git foi verificado no
repositório oficial do projeto.

| tarefa | external_id | status de deploy | bloqueio ativo | branch de integração | HEAD da branch | ancestral da base | classificação |
|---:|---|---|---:|---|---|---|---|
| 758 | `taqui-quick-actions-20260903-06` | `failed` | sim | `motor-v2/taqui-quick-actions-20260903-06/integracao` | `507cd23b2a5a596e3e765f4b549ee86da4f17b21` | sim | conflito histórico |
| 779 | `task-p2-779` | `failed` | sim | `motor-v2/task-p2-779/integracao` | `0b6071bd5f4dddcf12cc3ba493f44f239af522af` | sim | conflito |
| 787 | `task-p2-787` | `failed` | sim | `motor-v2/task-p2-787/integracao` | `4586a50cfc5b42e88675d73b08f1a227cafb132e` | sim | conflito |
| 795 | `task-p6-795` | `failed` | sim | `motor-v2/task-p6-795/integracao` | `4fbf04081575d3e3cca589ec92b53cbf3cd5e46d` | sim | conflito |

Na leitura atual, a tarefa 758 é `completed` pelo cálculo derivado (sete
subtarefas aprovadas, integração confirmada e deploy falho), e sua branch agora
é ancestral da base; ainda assim, o `failed` histórico e o bloqueio ativo
impedem a conversão automática. As tarefas 779,
787 e 795 satisfazem a forma `completed` prevista para deploy falho, mas o
`failed` histórico e o bloqueio ativo são conflitos e não devem ser convertidos
automaticamente em `succeeded`. Portanto, nesta subtarefa não há candidato
confirmado para persistência.

## Formato obrigatório do relatório

```text
{
  "candidatos": [{ "tarefaId", "externalId", "classificacao", "evidenciaGit", "evidenciaFactual" }],
  "evidenciaGit": [{ "repoPath", "baseBranch", "taskBranch", "head", "isAncestor" }],
  "acoes": [{ "tarefaId", "acao", "resultado", "idempotencia" }],
  "conflitos": [{ "tarefaId", "tipo", "evidencia", "decisao" }],
  "naoElegiveis": [{ "tarefaId", "motivo" }]
}
```

## Ordem de execução

1. Seleção de dados e cálculo do status derivado.
2. Verificação Git da ancestralidade da branch de integração na base.
3. Persistência histórica idempotente em `deploy_requests` somente para
   confirmações sem conflito.
4. Orquestração do lote de deploy conforme
   `docs/DEPLOY-AGRUPADO-MOTOR-OCIOSO.md`.
5. Validação integrada: reler fatos, status derivado, histórico e Git; emitir
   o relatório no formato acima.
