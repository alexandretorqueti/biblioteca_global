# Subtarefa 6 (id 1101) — Validação integrada: tsc, vitest, migration e não regressão

**Tarefa:** task-p2-828 — Configuração de deploy por projeto
**Data da validação:** 2026-09-29 23:55 BRT
**Worktree:** `worktrees/task-p2-828/1101/a1` · branch `motor-v3-work/subtask-task-p2-828-1101-a1` · base `0c2f85d`

## 1. tsc --noEmit e vitest no motor-v2

```
$ npx tsc --noEmit          → exit 0, sem erros
$ npx vitest run            → Test Files 76 passed (76)
                              Tests      641 passed (641)
```

## 2. Colunas novas na information_schema (projeto_640)

```
COLUMN_NAME        DATA_TYPE  IS_NULLABLE  COLUMN_DEFAULT
deploy_host_root   varchar    YES          NULL
deploy_script      varchar    YES          NULL
```

Projetos existentes em `projeto_motor_config` — todos com NULL (comportamento legado preservado):

```
projeto_id  deploy_script  deploy_host_root
1           NULL           NULL
2           NULL           NULL
6           NULL           NULL
7           NULL           NULL
12          NULL           NULL
```

(5 projetos — o critério citava 4; o projeto 12 foi provisionado depois. Todos NULL.)

## 3. Projeto com NULL continua usando o script padrão

`DeployScriptResolver.resolveDeployScript()` (motor-v2/src/deploy/DeployScriptResolver.ts):

- `deploy_script == null` → usa `defaultRelativeScript` legado e valida existência;
- `deploy_host_root == null` → fallback `DEPLOY_REPO_HOST` → `DEFAULT_DEPLOY_REPO_HOST`;
- script declarado → relativo ao gitTopLevel, sem `..`/absoluto, existência verificada antes do dispatch (falha imediata e clara).

Testes exigidos pelo critério (DeployScriptResolver.test.ts) — presentes e verdes:

- (a) "usa o script e a raiz de host declarados pelo projeto"
- (b) "preserva o script legado e usa DEPLOY_REPO_HOST quando deploy_script é NULL"
- (c) "falha imediatamente com projeto e caminho verificado quando o script não existe"

Extras verdes: rejeição de caminho absoluto/escape do toplevel, fallback de host sem
DEPLOY_REPO_HOST, e `assertUniformDeployBatch` (lote não mistura scripts efetivos).

## 4. Revisão do diff contra o escopo (merge-base bf64d04 → HEAD 0c2f85d)

```
A  SUBTAREFA-4-RESUMO.md                            (doc da subtarefa 4)
A  docs/DEPLOY-AGRUPADO-MOTOR-OCIOSO.md              (doc da subtarefa 5)
M  projects/gerenteagentes/__tests__/config.spec.ts  (+32: campos novos)
M  projects/gerenteagentes/__tests__/schema.spec.ts  (+36: colunas deploy_script/deploy_host_root)
M  projects/gerenteagentes/config.ts                 (+4: campos deployScript/deployHostRoot na tela)
```

- `deploy-host.sh` da biblioteca: **intacto** (diff = 0 linhas).
- Containers atuais: intactos (nenhuma alteração de compose/infra no diff).
- Nenhum gatilho, política ou formato de fila alterado no diff remanescente.
- O commit `0c2f85d` (remover migration 0051 órfã da raiz, duplicado inerte da
  canônica 0073) já está incorporado à base da branch.

**Observação (não bloqueante):** `SUBTAREFA-4-RESUMO.md` ficou na raiz do monorepo;
sugere-se mover para `projects/gerenteagentes/docs/` em tarefa futura de organização.

## Resultado

Todos os critérios de aceite atendidos. Subtarefa 6 concluída — validação integrada
verde, sem regressão e sem alterações fora do escopo.
