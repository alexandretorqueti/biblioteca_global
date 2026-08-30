# Motor v2 - Paralelismo Controlado

Motor de execução de tarefas com suporte a paralelismo controlado e gerenciamento de recursos.

## 🎯 Objetivo

Evoluir o motor de tarefas para suportar:
- ✅ Execução paralela de até 2 tarefas simultâneas (Etapa 8)
- ✅ Locks por projeto para evitar conflitos (Etapa 7)
- ✅ Espera orientada a eventos (Etapa 9)
- ✅ Tarefas de projetos diferentes em paralelo, com limite configurável
- ✅ Subtarefas da mesma tarefa em sequência estrita

## 📐 Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                    TaskCoordinator                          │
│  - Seleciona tarefas elegíveis                              │
│  - Gerencia workers (até MAX_WORKERS)                       │
│  - Coordena aquisição de recursos                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  ResourceLeaseService                       │
│  - Gerencia locks persistentes no banco                     │
│  - Heartbeat e expiração automática                         │
│  - Fila de espera por recursos                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     WorkerLauncher                          │
│  - Spawna processos filhos isolados                         │
│  - Comunicação via IPC                                      │
│  - Monitora health dos workers                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      TaskWorker                             │
│  - Executa pipeline de subtarefas                           │
│  - Isolamento por processo                                  │
│  - Reporta progresso via eventos                            │
└─────────────────────────────────────────────────────────────┘
```

## 🏗️ Estrutura

```
motor-v2/
├── src/
│   ├── coordinator/
│   │   └── TaskCoordinator.ts       # Scheduler principal
│   ├── workers/
│   │   ├── WorkerLauncher.ts        # Gerenciador de workers
│   │   ├── TaskWorker.ts            # Script do worker
│   │   └── WorkerProtocol.ts        # Protocolo de mensagens
│   ├── resources/
│   │   ├── ResourceLeaseService.ts  # Gerenciamento de locks
│   │   ├── ResourceEventBus.ts      # Barramento de eventos
│   │   ├── ResourceWaitManager.ts   # Fila de espera
│   │   └── schema.sql               # DDL do banco
│   ├── execution/
│   │   └── ExecutionContextManager.ts # Contexto isolado
│   ├── reconciler/
│   │   └── ExpirationReconciler.ts  # Reconciliação de locks
│   ├── api/
│   │   └── MotorAPI.ts              # Endpoints REST
│   ├── steps/
│   │   └── MotorMonitorStep.ts      # Lock do monitor
│   ├── shared/
│   │   └── types/
│   │       ├── index.ts             # Tipos principais
│   │       ├── execution.ts         # Contexto de execução
│   │       └── resources.ts         # Recursos e locks
│   ├── Motor.ts                     # Entry point principal
│   ├── start.ts                     # Script de inicialização
│   └── index.ts                     # Exports públicos
└── test/
    ├── ResourceLeaseService.test.ts
    ├── TaskCoordinator.test.ts
    └── MotorMonitorStep.test.ts
```

## 🚀 Uso

### Ambiente E2E isolado

Os testes integrados não usam a fila nem os dados do projeto Biblioteca Global.
O ambiente dedicado contém um MySQL `motor-v2-e2e-mysql`, o Motor
`motor-v2-e2e-test` na porta `3011`, e o projeto fixture `motor-v2-e2e` no
schema `projeto_640`. O fixture Git está em
`.motor-v2-e2e-fixture`, tem remoto bare local e workspaces temporários em
`.motor-v2-e2e-workspaces`.

O runtime/Console continua sendo real; as credenciais ficam exclusivamente nas
variáveis `MYSQL_*`, `OPENCLAW_CONSOLE_URL` e `OPENCLAW_CONSOLE_TOKEN`. Não há
credenciais versionadas. A evidência e os cenários pendentes estão em
[`PENDENCIAS.md`](../../../../../agentes/gerenteagentes/PENDENCIAS.md).

O runner reproduzível está em `motor-v2/scripts/e2e-testbed.sh`. Ele não cria
containers nem altera configuração do OpenClaw; valida os containers dedicados,
prepara a fixture Git local e imprime evidência sanitizada:

```bash
motor-v2/scripts/e2e-testbed.sh check
motor-v2/scripts/e2e-testbed.sh fixture
motor-v2/scripts/e2e-testbed.sh evidence
```

Os nomes dos containers, a URL do Motor e os diretórios da fixture podem ser
sobrescritos por `MOTOR_E2E_CONTAINER`, `MYSQL_E2E_CONTAINER`,
`MOTOR_E2E_URL`, `MOTOR_E2E_FIXTURE_DIR`, `MOTOR_E2E_REMOTE_DIR` e
`MOTOR_E2E_WORKSPACES_DIR`. Tokens devem ser fornecidos somente pelo ambiente
do container ou por arquivo local fora do repositório.

```bash
# Iniciar motor
npm start

# Health check
curl http://localhost:3010/api/motor/health

# Estatísticas
curl http://localhost:3010/api/motor/stats

# Forçar pump manual
curl -X POST http://localhost:3010/api/motor/pump
```

## 📊 Fluxo de Execução

1. **TaskCoordinator.pump()** é chamado periodicamente (30s)
2. Seleciona próxima tarefa elegível (status `planned`)
3. Tenta adquirir lock do projeto via `ResourceLeaseService`
4. Se lock disponível → spawna `TaskWorker` em processo filho
5. Se lock ocupado → tarefa vai para fila de espera
6. Worker executa pipeline completo e reporta resultado
7. Coordinator libera lock e tenta próxima tarefa
8. `ExpirationReconciler` detecta locks expirados e retoma tarefas

## 🔒 Locks e Recursos

### Tipos de Recursos

- `project:{slug}:execution` - Lock por projeto (evita 2 tarefas do mesmo projeto simultâneas)
- `motor:monitor` - Lock do monitor (apenas 1 correção por vez)

### Fencing Token

Cada lock tem um `fencingToken` incremental para garantir que:
- Locks antigos não possam sobrescrever locks novos
- Operações stale sejam rejeitadas
- Condição de corrida seja evitada

### Heartbeat

Workers renovam locks a cada 10s:
```sql
UPDATE execution_resources 
SET heartbeat_at = NOW(), expires_at = NOW() + INTERVAL 60 SECOND
WHERE resource_key = ? AND execution_id = ? AND fencing_token = ?
```

### Expiração

`ExpirationReconciler` roda a cada 30s e detecta:
- Locks expirados (sem heartbeat)
- Tarefas órfãs (running sem lock)
- Tarefas pausadas há muito tempo

## 🧪 Testes

```bash
# Rodar todos os testes
npm test

# Rodar com coverage
npm run test:coverage
```

## 📈 Roadmap

### ✅ Implementado

- [x] **Etapa 0-3**: Fundação (tipos, ResourceLease, EventBus)
- [x] **Etapa 4**: Motor Monitor com lock exclusivo
- [x] **Etapa 5**: Worker isolado via child_process
- [x] **Etapa 6**: Espera orientada a eventos (EventBus + WaitManager)
- [x] **Etapa 7**: Locks por projeto
- [x] **Etapa 8**: Paralelismo controlado (MAX_WORKERS=2)
- [x] **Etapa 9**: Reconciliador de expiração
- [x] **Etapa 10**: API REST

### ⏳ Próximos Passos

- [x] **Etapa 11**: Integração real com banco de dados (`DrizzleDb`/`mysql2`)
- [x] **Etapa 12 (decisão revisada)**: Subtarefas sequenciais dentro de uma tarefa; o paralelismo ocorre entre tarefas/projetos
- [ ] **Etapa 13**: Deploy em produção e migração gradual
- [x] **Etapa 14**: Recuperação de worker travado e lease perdido

### Recuperação de workers

O coordenador controla o ciclo de vida do worker com duas proteções:

- timeout máximo por execução, usando `workerTimeoutMs` quando configurado e,
  na ausência dele, `hard_timeout_ms` da tarefa;
- reação imediata à perda do lease: o worker é encerrado, a subtarefa e a
  tarefa são marcadas como bloqueadas com o motivo, o recurso é liberado e o
  `pump()` pode selecionar a próxima execução.

O encerramento é idempotente para evitar que timeout, heartbeat e o evento de
saída do processo finalizem a mesma execução duas vezes. A implementação e os
testes unitários estão concluídos; a simulação E2E de worker suspenso/lease
expirado permanece no inventário de validação.

### Evoluções de 2026-08-30

- **Pipeline Git validado:** o cenário isolado confirmou worktree, gate,
  commit, publicação de branch, merge e limpeza recuperável; o caminho sem
  alterações também conclui sem commit desnecessário.
- **Rework validado:** um gate controlado falhou uma vez e passou na segunda
  entrega, com `deliver_count=2`. A seleção de subtarefa passou a carregar
  `max_rework` e `hard_timeout_ms` da tarefa, antes dos defaults do projeto.
- **Sessões:** labels e chaves usam `analysis-<modelo>-<codigo-tarefa>` e
  `dev-<modelo>-<codigo-tarefa>`. O fechamento usa `DELETE /api/sessions` para
  remover o transcript; uma execução E2E completa confirmou que não sobra
  sessão do teste no Console.
- **Validação atual:** 15 arquivos de teste e 65 testes aprovados, além de
  typecheck e lint. O inventário completo de cenários e pendências está no
  `PENDENCIAS.md` do workspace.

## 🔧 Configuração

```typescript
const motor = new Motor({
  db: databaseInstance,
  repository: taskRepository,
  maxWorkers: 2,                    // Máximo de workers simultâneos
  apiPort: 3010,                    // Porta da API REST
  reconcilerIntervalMs: 30000,      // Intervalo do reconciliador
})
```

Para habilitar a publicação no feed ao iniciar pelo `start.ts`, configure `LIBRARY_REALTIME_EVENTS_TOKEN`. O endpoint pode ser sobrescrito por `LIBRARY_REALTIME_EVENTS_URL`; o padrão é `http://localhost:3001/internal/realtime/events`. O token deve permanecer somente em `.env`/secrets.

## 🐛 Troubleshooting

### Lock não é liberado

Verifique se `ExpirationReconciler` está rodando:
```bash
# Logs devem mostrar:
[ExpirationReconciler] Iniciando (intervalo: 30000ms)
```

### Worker não inicia

Verifique se `TaskWorker.js` foi compilado:
```bash
npm run build
```

### API não responde

Verifique se a porta 3010 está disponível:
```bash
netstat -tuln | grep 3010
```

## 📚 Referências

- [Documentação de Paralelismo](../../../../../docs/architecture/paralelismo/)
- [ADR-0004: Arquitetura do Motor](../../../../../docs/architecture/decisions/0004-motor-architecture.md)

## 📄 Licença

Proprietário - Global Tecnologia
