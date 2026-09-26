# Observabilidade — Motor v2

## Log estruturado

Todo log do motor passa pelo logger de `src/shared/logger.ts`:

```
2026-08-30T19:31:42.406Z INFO  [ExpirationReconciler] taskId=41 Tarefa órfã: 41
2026-08-30T19:31:42.406Z ERROR [TaskCoordinator] taskId=task-81 executionId=exec-1 Falha: [timeout] Worker excedeu...
```

- **Formato padrão (text):** `timestamp ISO`, nível, `[componente]`, contexto
  `chave=valor` e mensagem. Com `MOTOR_LOG_FORMAT=json`, uma linha JSON por
  evento (`{timestamp, level, component, message, taskId?, subtaskId?,
  executionId?, phase?, ...}`).
- **Correlação:** sempre que disponível, a linha carrega `taskId`,
  `subtaskId`, `executionId` e `phase` — suficiente para reconstruir a linha
  do tempo de uma execução com `grep executionId=`.
- **Componentes:** `Motor`, `MotorStart`, `MotorAPI`, `TaskCoordinator`,
  `WorkerLauncher`, `GitWorkspaceManager`, `ExpirationReconciler`,
  `ResourceWaitManager`. Logs do processo worker (stdout/stderr) são
  re-emitidos pelo `WorkerLauncher` com o `executionId` da execução.

### Variáveis de ambiente

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `MOTOR_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MOTOR_LOG_FORMAT` | `text` | `json` para ingestão por ferramenta |
| `MOTOR_LOG_FILE` | (sem) | caminho para espelhar o log em arquivo (append) |

### Recomendação de produção

Definir `MOTOR_LOG_FILE=/var/log/motor-v2/motor.log` (volume do container) e
`MOTOR_LOG_LEVEL=info`. Para depurar uma execução específica sem ruído global:
subir o nível para `debug` temporariamente e filtrar por `executionId`.

## Stats e health

- `GET /api/motor/health` — `{ ok, runtime: "motor-v2", timestamp }`.
- `GET /api/motor/stats` — visão operacional:

```json
{
  "activeWorkers": 1,
  "maxWorkers": 1,
  "maxWorkersPerProject": 1,
  "workers": [
    {
      "executionId": "exec-execute-9-1756590000000",
      "taskId": "727",
      "subtaskId": 717,
      "phase": "execute",
      "projectSlug": "gerenteagentes",
      "startedAt": "2026-08-30T19:20:00.000Z",
      "ageMs": 45000,
      "lastHeartbeatAt": "2026-08-30T19:20:40.000Z"
    }
  ]
}
```

`ageMs` alto com `lastHeartbeatAt` parado indica worker travado (o watchdog de
silêncio atua em 10 min sem heartbeat). `activeWorkers` em `maxWorkers` por
muito tempo com fila parada indica gargalo de capacidade — avaliar
`MOTOR_MAX_WORKERS` (ver `docs/fluxo-motor.md`).

## Eventos em tempo real

O `ExecutionEventBus` publica o ciclo de vida (`started`, `progress`,
`heartbeat`, `log`, `model_unavailable`, `developer_branch_integrated`,
`completed`, `failed`) e o `LibraryRealtimeBroadcaster` encaminha para a API de
realtime da Biblioteca quando `LIBRARY_REALTIME_EVENTS_TOKEN` está definido —
é a fonte da tela "Acompanhar Tarefa".

## Fontes de evidência em incidente

1. Log estruturado do container (`MOTOR_LOG_FILE` ou stdout do container).
2. `projeto_640.bloqueios` (motivo + fingerprint + evidência por bloqueio).
3. `node dist/scripts/recover.js status` (estado preso: tarefas bloqueadas,
   integrações pendentes, leases).
4. `GET /api/motor/stats` (workers e idade).
