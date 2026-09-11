# Contrato de workspace da sessão — Motor → Console (investigação, 2026-09-11)

Documento de operação **e de decisão pendente**. Existe porque a tarefa
`task-p2-812 / subtarefa 1012` foi bloqueada assim:

```
[error] Ambiente bloqueado: pwd returned
'/data/workspace/projects/agentes/gerenteagentes' instead of expected
'/data/workspace/projects/agentes/gerenteagentes/worktrees/task-p2-812/1012/a2/projects/gerenteagentes'
```

O agente estava certo em bloquear: rodou no diretório do agente, não no worktree.

## O que foi descoberto (com evidência)

### 1. O Gateway NÃO aceita `spawnedCwd` em sessão normal

Fonte autoritativa: `/opt/openclaw/app/src/gateway/sessions-patch.ts`

```ts
function supportsSpawnLineage(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}
// ...
const checkSpawnLineage = (field: string): PatchError =>
  supportsSpawnLineage(storeKey)
    ? null
    : invalid(`${field} is only supported for subagent:* or acp:* sessions`);
```

`spawnedCwd` é campo **imutável** e passa por `checkSpawnLineage`. Logo:

> **Só sessões `subagent:*` ou `acp:*` aceitam `spawnedCwd`.**

Confirmado em produção: ao enviar `workspacePath` numa sessão normal, o Gateway
respondeu e o Motor registrou o bloqueio:

```
[error] spawnedCwd is only supported for subagent:* or acp:* sessions
```

### 2. O Console também não devolve o cwd

`openclaw-console-app` (`apps/server/src/index.ts`):

- `POST /api/sessions` aceita `workspacePath`, valida (absoluto, descendente de
  `OPENCLAW_SESSION_WORKSPACE_ROOT`, default `/data/workspace/projects/agentes`,
  sem escape por symlink) e chama `sessions.patch` com `{ spawnedCwd }`;
- o `POST` devolve apenas `{ ok, key, sessionId?, runStarted? }`;
- `GET /api/sessions/describe` repassa o `sessions.describe` do Gateway e
  **não expõe** `spawnedCwd`.

Ou seja: não há leitura de volta do cwd. A única garantia possível é o Gateway
aceitar o patch — e ele só aceita para `subagent:*`/`acp:*`.

### 3. Conclusão

O Motor **não consegue** fixar o cwd de uma sessão normal de desenvolvimento pelo
Console. O caminho do worktree vai no prompt, e o agente opera por caminhos
absolutos a partir do seu próprio workspace. Esta é a situação atual (e foi a
decisão original do código, que estava documentada em comentário).

## Estado do código após esta investigação

- `TaskWorker`: **não** envia `workspacePath` em sessão de desenvolvimento
  (comentário no código aponta a regra do Gateway acima). Mantém a guarda de que
  tarefa de desenvolvimento sem `repoPath` falha cedo.
- `ConsoleAgentRuntimeDriver`: mantém suporte a `workspacePath` (aceitável
  quando o chamador usa sessão `subagent:*`/`acp:*`) e a tradução de
  `INVALID_WORKSPACE_PATH` para `WorkspaceBindingError`. `assertSessionWorkspace`
  valida cwd reportado quando existir (ausência de eco não é erro).
- `ModelTierPolicy.formatSessionKey`: formato original
  (`<fase>-<modelo>-<tarefa>[-s<subtarefa>]`), estável no rework.

## Opções para resolver de verdade (decisão do Alexandre)

| # | Opção | Como | Risco |
| --- | --- | --- | --- |
| A | Sessão de desenvolvimento como **subagente/ACP** | abrir a sessão com chave `subagent:*` (ou runtime ACP) e então enviar `spawnedCwd` = caminho do worktree, que o Gateway aceita | médio: muda o tipo de sessão (isolamento/limpeza próprios); precisa validar no Console |
| B | Manter como hoje (prompt + caminhos absolutos) | nada a mudar | o agente pode falhar/bloquear quando a regra dele exigir cwd == worktree |
| C | Preparar o worktree **no** workspace do agente | montar o checkout dentro do caminho em que a sessão já roda | baixo, mas reposiciona a árvore de worktrees do Motor |

Enquanto não houver decisão, tarefas que exigem cwd isolado continuam sujeitas a
bloqueio `blocked_environment` — que a varredura de retomada automática tenta de
novo (teto de 3/24h) em vez de ficar parada para sempre.

## Camadas de defesa hoje

| Camada | Quem | O que faz |
| --- | --- | --- |
| 1 | Motor | valida `repoPath`, informa o worktree no prompt; sessão estável por subtarefa+modelo |
| 2 | Console | valida `workspacePath` se enviado (raiz, symlink) — patch de `spawnedCwd` só passa em `subagent:*`/`acp:*` |
| 3 | Agente | confere `pwd` e bloqueia se divergir (regra de segurança do agente) |
| 4 | Coordenador | trata o bloqueio como ambiente, libera espelho de tarefa e retoma automaticamente com teto |
