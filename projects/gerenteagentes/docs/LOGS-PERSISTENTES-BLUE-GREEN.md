# Logs de Execução Persistentes — blue-green sem perda de auditoria

> Melhoria #5 do ciclo manual 2026-10-29. Incidente motivador: o swap
> blue-green de 29/10 removeu o container blue e levou junto o histórico das
> tentativas 1–2 da subtarefa 1447 — auditoria perdida. **A auditoria de
> tentativas não pode depender da vida do container.**

## Solução implementada: dump pré-remoção (sem tocar no compose)

`scripts/deploy-blue-green.sh` agora faz dump de `docker logs --timestamps`
(gzip) para diretório persistente no **host** antes de qualquer remoção de
container:

| Momento | O que é dumpado | Rótulo do dump |
|---|---|---|
| Antes do `down` da stack antiga (pós-swap bem-sucedido) | Todos os containers do projeto compose antigo (descobertos por label; fallback: nomes `-api-1`/`-web-1`) | `<projeto>-removido` |
| Stack legacy removida | `biblioteca-global-api[-1]`, `biblioteca-global-web[-1]` (nomes explícitos) | `legacy-removido` |
| `cleanup_new` (trap ERR — deploy novo falhou) | Containers da stack nova que falhou (principal evidência do fracasso) | `<projeto>-failed` |
| Limpeza de slot residual no início (deploy anterior morreu sem trap) | Containers residuais do slot alvo, se existirem | `<projeto>-residual` |

- **Destino:** `/home/alexandre/containers/biblioteca-global/logs/<UTC-ts>-<rótulo>/`
  (mesma base do `blue-green-state`; fora dos containers, sobrevive ao swap).
- **Metadados:** cada dump grava `dump-info.txt` (timestamp, projeto, commit,
  `deploy_batch_id`, slots ativo/alvo).
- **Retenção:** últimos `BLUE_GREEN_LOG_KEEP` dumps (padrão **20**); mais
  antigos são removidos automaticamente.
- **Best-effort total:** qualquer falha do dump NÃO aborta o deploy.

## Configuração (envs opcionais do script de deploy)

| Env | Padrão | Efeito |
|---|---|---|
| `BLUE_GREEN_LOG_DIR` | `/home/alexandre/containers/biblioteca-global/logs` | Raiz dos dumps |
| `BLUE_GREEN_LOG_KEEP` | `20` | Quantidade de dumps retidos |

## Limitação conhecida + proposta de infra (ação do Alexandre)

O dump pré-remoção cobre o swap blue-green e falhas de deploy, mas **não**
cobre morte do container fora do deploy (crash/OOM/`docker rm` manual).
Cobertura completa exigiria volume de log no `docker-compose.yml`
(ex.: driver `local` com `max-size`/`max-file`, ou bind mount de
`/home/alexandre/containers/biblioteca-global/docker-logs` + app escrevendo
em arquivo). Compose é infra do Alexandre — **proposto, não implementado**.

## Validação

- `bash -n` limpo.
- Smoke test com docker fake (extração das funções reais do script): dump por
  label + gzip íntegro + `dump-info.txt`, fallback de nomes explícitos,
  caminho legacy e retenção keep=3 — 4/4 OK (2026-10-30).
