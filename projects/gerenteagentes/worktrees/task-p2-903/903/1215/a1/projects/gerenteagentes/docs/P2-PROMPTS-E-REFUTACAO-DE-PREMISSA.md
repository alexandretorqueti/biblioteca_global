# P2 — prompts administráveis e refutação de premissa

## Objetivo

Evitar que o Motor execute missões tecnicamente falsas e permitir que administradores revisem os prompts sem alterar código ou fazer deploy.

## Prompts administráveis

- `prompts_agentes`: chave funcional, agente, situação e versão ativa.
- `prompts_mascaras`: contrato e explicação dos valores dinâmicos.
- `prompts_versoes`: histórico imutável de rascunhos/publicações.
- `prompts_execucoes`: versão usada por tarefa/subtarefa e indicação de fallback.

A tela **Prompts** permite editar, validar máscaras, visualizar com dados fictícios, publicar e restaurar versões. Somente `admin` e `gerente` acessam os endpoints de administração.

O Motor consulta a versão `active`. Ausência da tabela, falha no banco, versão ausente ou erro de renderização usam o compositor embarcado. Cada resolução tenta registrar a chave/versão em `prompts_execucoes`.

## Protocolo `premise_incorrect`

O agente pode refutar a missão somente com:

```json
{
  "status": "premise_incorrect",
  "claim": "alegação objetiva",
  "conflict_type": "source_of_truth_conflict",
  "evidence": [{ "path": "schema.ts", "observation": "evidência" }],
  "suggested_revision": "como corrigir o briefing"
}
```

Tipos aceitos: `source_of_truth_conflict`, `missing_prerequisite`, `scope_mismatch`, `acceptance_conflict` e `already_satisfied`.

O auditor determinístico rejeita caminhos absolutos, arquivos fora do worktree, arquivos inexistentes, evidência vazia e contratos incompletos. Refutação inválida volta ao executor. Refutação válida segue para rebriefing do analista.

## Substituição versionada

A original nunca é editada para parecer outra missão:

1. original recebe `status=superseded`;
2. evidência, fingerprint e vínculo com a substituta são preservados;
3. nova linha recebe a mesma posição lógica, `revision+1` e `replaces_subtask_id`;
4. posteriores aguardam a revisão;
5. promoção ignora a linha `superseded`, mas exige a revisão verificada e integrada.

Há no máximo dois rebriefings automáticos. Fingerprint repetido ou terceira revisão bloqueiam para decisão humana.

## Branch por tarefa

Antes de qualquer worktree de subtarefa, `TaskCoordinator` chama `ensureTaskIntegration`. A subtarefa é criada com `baseBranch=taskWorkspace.branch`; portanto, toda revisão também nasce do tip da branch de integração da tarefa.

## Migração

Aplicar `migrations/0019_prompts_e_refutacao.sql` antes de ativar a versão. A sincronização do catálogo cria metadados e uma versão inicial em rascunho sem sobrescrever versões existentes. Nenhum prompt persistido fica ativo automaticamente.

## Evolução da plataforma

A ligação temporária da tela permanece no registry central, autorizada pelo Alexandre. A tarefa `#766 / task-biblioteca-766` foi criada no projeto Biblioteca Global para descentralizar registries por projeto; após sua entrega, o import específico deve migrar para `projects/gerenteagentes/screens/registry.ts`.
