# Preparação do Worktree — Segredos e Dependências

> Documento do Motor-v2. Descreve o fluxo de preparação do worktree antes da execução do agente.

## Fluxo Completo

```
1. PREFLIGHT (TaskCoordinator, antes da ANALYZE)
   └─ resolveGitTopLevel(repoPath) → lê task-environment.json do toplevel git
   └─ SecretProfileManager.inspectManifest() → valida manifesto + presença de obrigatórios
   └─ Falha → tarefa bloqueada (blocked_environment), modelo NÃO consumido

2. PREPARE (TaskWorker, após validar worktree/branch)
   ├─ 2a. materializeManifest() → escreve .env no worktree (modo 0600)
   │      └─ Segurança git: ls-files (não rastreado) + check-ignore (ignorado)
   └─ 2b. npm ci → instala dependências se houver package-lock.json
          └─ Salvaguarda: git status antes/depois; falha se alterar rastreados

3. EXECUTE → agente trabalha com .env + node_modules prontos
```

## Variáveis de Configuração

| Variável | Default | Descrição |
|---|---|---|
| `TASK_SECRETS_ROOT` | _(obrigatório para segredos)_ | Raiz segura dos arquivos `.env` de segredos. Nunca versionar. |
| `TASK_ENVIRONMENT` | `development` | Ambiente atual (usado na interpolação `${environment}`). |
| `TASK_DEPENDENCY_INSTALL_TIMEOUT_MS` | `900000` (15min) | Timeout do `npm ci`. |

## Formato do Manifesto (`task-environment.json`)

Localização: raiz do toplevel git do repositório (não necessariamente o `repo_path` registrado, pois projetos podem ficar dentro de monorepos).

```json
{
  "version": 1,
  "files": [
    {
      "source": "shared/${environment}.env",
      "target": ".env",
      "required": false
    },
    {
      "source": "${projectSlug}/${environment}.env",
      "target": ".env",
      "required": true
    }
  ]
}
```

### Regras

- `version`: deve ser `1`.
- `files`: array de entradas.
  - `source`: caminho relativo a `TASK_SECRETS_ROOT`. Suporta `${environment}` e `${projectSlug}`.
  - `target`: caminho relativo à raiz do worktree. Deve ser `.env` ou `.env.*`. Caminhos absolutos e `..` são rejeitados.
  - `required`: booleano. Se `true` e o arquivo estiver ausente (ou `TASK_SECRETS_ROOT` não configurado), a tarefa é **bloqueada**.
- Entradas com o mesmo `target` são mescladas; chaves posteriores sobrescrevem as anteriores.

## Estrutura da Raiz de Segredos

```
$TASK_SECRETS_ROOT/
├── shared/
│   ├── development.env
│   ├── staging.env
│   └── production.env
└── <projectSlug>/
    ├── development.env
    ├── staging.env
    └── production.env
```

Cada arquivo é um `.env` padrão (`CHAVE=valor`, uma por linha).

## Segurança Git

Antes de materializar cada alvo, o motor verifica:

1. **Não rastreado** (`git ls-files --error-unmatch`): o alvo não pode estar versionado.
2. **Ignorado** (`git check-ignore -q`): o alvo deve estar no `.gitignore`.

Se qualquer verificação falhar, a materialização é **bloqueada** com erro `segurança_git`.

Em diretórios que não são repositórios git (ex.: testes), o check é pulado.

## npm ci

Após a materialização de segredos, se existir `package-lock.json` na raiz do worktree:

1. Captura `git status --porcelain` (antes).
2. Executa `npm ci` com timeout configurável.
3. Captura `git status --porcelain` (depois).
4. Se arquivos **rastreados** foram alterados → falha (inconsistência lock/package).
5. Arquivos não-rastreados (ex.: `node_modules/`) são ignorados na comparação.

Sem `package-lock.json` → pula (não roda `npm install`).

## Monorepo (caso gerenteagentes)

O `repo_path` do projeto gerenteagentes aponta para `projects/gerenteagentes`, dentro do monorepo biblioteca-global. O git worktree é criado para o monorepo inteiro. Portanto:

- O manifesto `task-environment.json` é lido do **toplevel git** (`git rev-parse --show-toplevel`), não do `repo_path` registrado.
- O `npm ci` roda na raiz do worktree (raiz do monorepo, onde está o `package-lock.json`).
- O `target` do `.env` deve apontar para onde a aplicação lê (ex.: `projects/gerenteagentes/.env`).

## Implantação

Para ativar em produção:

1. Configurar `TASK_SECRETS_ROOT` no container `biblioteca-global-api`.
2. Configurar `TASK_ENVIRONMENT` (default `development`).
3. Criar os arquivos de segredo na raiz configurada.
4. Garantir que `.env` está no `.gitignore` do repositório.

**Nunca versionar segredos.**

## Referência

- Comportamento original (legado): `GerenteAgentes/docs/SEGREDOS-E-WORKSPACES.md`
- Classe: `motor-v2/src/workspaces/SecretProfileManager.ts`
- Integração preflight: `motor-v2/src/coordinator/TaskCoordinator.ts` → `runManifestPreflight()`
- Integração materialização: `motor-v2/src/workers/TaskWorker.ts` → `phasePrepare()`
