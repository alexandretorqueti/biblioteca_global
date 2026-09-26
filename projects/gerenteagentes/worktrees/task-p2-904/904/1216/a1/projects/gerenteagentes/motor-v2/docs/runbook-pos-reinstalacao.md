# Runbook Pós-Reinstalação — Motor v2 / Biblioteca Global

A reinstalação do host (ServerIA) muda binds, permissões e caminhos. O motor
depende de vários deles; quando um quebra, a falha aparece depois, mascarada
(ex.: subtarefa bloqueada com "repositório não encontrado"). Este runbook
existe para validar o ambiente **antes** de lançar tarefas.

## Verificação automática

```bash
bash projects/gerenteagentes/motor-v2/tools/check-pos-reinstalacao.sh
```

Roda no host, usa `docker` contra os containers `biblioteca-global-api` e
`biblioteca-global-mysql`, e lê o `.env` da raiz do monorepo. Saída:
`[PASS]`/`[FAIL]` por item + resumo final (exit code 0 = tudo ok).

## Itens verificados e como corrigir cada falha

| # | Item | Correção |
|---|------|----------|
| 1 | Binds do repositório e dos agentes montados no container | ajustar `volumes` no compose usado no deploy e recriar o container |
| 2 | `repo_path` de `projeto_motor_config` e `projetos_captados` existem **dentro** do container | `UPDATE` com o caminho real montado (ex.: `/home/alexandre/codigofonte/biblioteca-global`) |
| 3 | Chave SSH de push: arquivo (não diretório) + autentica no GitHub | restaurar a chave no caminho do bind (`chmod 600`); se virou diretório vazio, removê-lo e recriar o arquivo, ou apontar `GITHUB_SSH_KEY_HOST` no `.env` para chave válida |
| 4 | `host.docker.internal` resolve + `OPENCLAW_CONSOLE_URL` alcançável | garantir `extra_hosts: host.docker.internal:host-gateway` **no compose efetivamente usado** (verificar label `com.docker.compose.project.config_files` do container) |
| 5 | MySQL, `core` e tabelas do banco do motor (`projeto_640`) | restaurar backups/restaurar containers |
| 6 | Motor health + tarefas bloqueadas/órfãs | `recover.js status` (runbook-recuperacao.md); órfãs são retomadas pelo `ExpirationReconciler` quando o lease expira |

## Casos reais (2026-09-03)

1. **repo_path antigo:** banco apontava `/run/media/alexandre/12T/...` (bind
   anterior). Correção: UPDATE para `/home/alexandre/codigofonte/biblioteca-global`.
2. **Chave virou diretório:** bind inexistente na reinstalação fez o Docker
   criar um diretório no lugar do arquivo da chave → publish falhou com
   "UNPROTECTED PRIVATE KEY". Correção: `GITHUB_SSH_KEY_HOST` no `.env`
   apontado para chave pessoal válida (autenticando como `alexandretorqueti`).
3. **extra_hosts no compose errado:** o fix estava em
   `infra/docker/compose.biblioteca.yaml`, mas o deploy usa o
   `docker-compose.yml` da raiz → `ENOTFOUND host.docker.internal`. Correção:
   aplicar o `extra_hosts` no compose da raiz (commit d05c442).

## Depois de corrigir

1. Recriar o container afetado (`docker compose up -d <serviço>`).
2. Rodar o checklist de novo até fechar com 0 falhas.
3. Se havia tarefa bloqueada: `node dist/scripts/recover.js unblock --tarefa <id>`
   dentro do container, depois `POST /api/motor/pump`.
