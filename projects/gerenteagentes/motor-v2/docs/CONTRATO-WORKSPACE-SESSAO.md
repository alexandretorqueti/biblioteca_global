# Contrato de workspace da sessão — Motor → Console

Documento de operação. Existe porque, em 2026-09-11, a tarefa **task-p2-812 /
subtarefa 1012 / tentativa a2** foi bloqueada assim:

```
[error] Ambiente bloqueado: pwd returned
'/data/workspace/projects/agentes/gerenteagentes' instead of expected
'/data/workspace/projects/agentes/gerenteagentes/worktrees/task-p2-812/1012/a2/projects/gerenteagentes'
```

O agente estava certo em bloquear: ele rodou no **repositório-base** em vez do
worktree isolado. O defeito era do Motor.

## Por que acontecia (causa raiz)

1. **O Motor não enviava `workspacePath`** ao criar sessões normais de
   desenvolvimento. O comentário anterior no código afirmava que o Console só
   suportava `workspacePath` para `subagent:*`/`acp:*` — **isso é falso** na
   versão atual do Console.
2. **A chave da sessão não distinguia a entrega/tentativa**
   (`dev-<modelo>-<tarefa>-s<subtarefa>`). Uma nova tentativa podia reutilizar
   uma sessão criada com o cwd de um worktree anterior.
3. Sem `workspacePath`, o Console não grava `spawnedCwd`, e o run do agente
   acontece no diretório padrão do agente (a base do projeto).

## Como o Console realmente funciona (evidência no código do Console)

`POST /api/sessions`:

- aceita `workspacePath` e o valida (`assertValidSessionWorkspacePath`):
  precisa ser caminho absoluto, sem byte nulo, **descendente da raiz de
  workspaces** do Console e sem escape por symlink (realpath);
- cria a sessão no Gateway (`sessions.create`) e, em seguida, faz
  `sessions.patch` com `{ spawnedCwd: workspacePath }` — é esse patch que define
  o cwd do run seguinte;
- **não devolve** `spawnedCwd` na resposta (`{ ok, key, sessionId?, runStarted? }`).

`GET /api/sessions/describe`: repassa o `sessions.describe` do Gateway e
**também não expõe** `spawnedCwd`. `spawnedCwd` é campo **patch-only**
(`PatchSessionRequestSchema`).

Consequência prática: **não existe leitura de volta do cwd pelo Console**. A
garantia tem que ser construída na escrita + validada pelo próprio run.

## O que o Motor garante agora

1. **Sempre envia `workspacePath`** em sessão de desenvolvimento
   (`ConsoleAgentRuntimeDriver.createSession`).
2. **Falha rápido** se a tarefa de desenvolvimento não tem `repoPath`
   (`WorkspaceBindingError` no `TaskWorker`) — nunca abre sessão sem workspace.
3. **Traduz rejeição do Console** (`INVALID_WORKSPACE_PATH`) em
   `WorkspaceBindingError`, com mensagem explicando que o worktree precisa estar
   dentro da raiz de workspaces e sem escape por symlink.
4. **Valida cwd divergente quando o Console ecoar** algum campo de cwd
   (`spawnedCwd`/`cwd`) — compatibilidade com versões futuras do Console.
5. **Sessão única por entrega**: `formatSessionKey` inclui `-g<generation>`
   (`generation = deliver_count`), então retry/rework nunca herda o cwd de uma
   sessão anterior.
6. **Bloqueio classificado como ambiente**: `WorkspaceBindingError` registra
   `blocked_environment` (não é culpa da entrega) e a varredura de retomada
   automática do coordenador reexecuta quando a causa for corrigida.

## Camadas de defesa (ordem)

| Camada | Quem | O que faz |
| --- | --- | --- |
| 1 | Motor | valida `repoPath`, envia `workspacePath`, sessão isolada por entrega |
| 2 | Console | valida o caminho (absoluto, dentro da raiz, sem escape por symlink) e aplica `spawnedCwd` |
| 3 | Agente | confere `pwd` no início do run e bloqueia se divergir (regra de segurança) |
| 4 | Coordenador | trata o bloqueio como ambiente e retoma automaticamente após a correção |

## Como diagnosticar de novo

```bash
# 1) o worktree existe e aponta para o gitdir correto?
ls -d /data/workspace/projects/agentes/<agente>/worktrees/<tarefa>/<sub>/a<N>
git -C <worktree> rev-parse --show-toplevel

# 2) a sessão foi criada com workspacePath? (o Console não ecoa, verifique no log do Motor)
grep -a "workspacePath\|WorkspaceBindingError\|spawnedCwd" <log do container biblioteca-global-api>

# 3) a raiz de workspaces do Console inclui o caminho do worktree?
#    (se não incluir, o Console responde INVALID_WORKSPACE_PATH)
```

Se o Console responder `INVALID_WORKSPACE_PATH`, o problema é de configuração de
raiz — **não** é a tarefa, não é o agente e não se resolve retomando.
