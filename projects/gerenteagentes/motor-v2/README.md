# Motor v2 - Paralelismo Controlado

Motor de execução de tarefas com suporte a paralelismo controlado e gerenciamento de recursos.

## 🎯 Objetivo

Evoluir o motor de tarefas para suportar:
- ✅ Execução paralela de até 2 tarefas simultâneas (Etapa 8)
- ✅ Locks por projeto para evitar conflitos (Etapa 7)
- ✅ Espera orientada a eventos (Etapa 9)
- ✅ Subtarefas paralelas dentro de uma tarefa (Etapa 12)

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

### Projeto de teste configurado

O alvo de teste do Motor-v2 é o projeto captado `biblioteca-global` no
database `projeto_640` (registro `projetos_captados.id = 1`). Ele usa o agente
`biblioteca-global`, a branch `base-desenvolvimento` e o repositório
`/run/media/alexandre/12T/codigofonte/biblioteca-global`, que é montado no
container da API pela variável `REPO_PATH` do `.env` local. O volume deve
apontar diretamente para esse diretório, e não para o diretório-pai.

A tarefa de aceite registrada para esse alvo é
`task-v2-bib-1787962293` (`status = ready`; subtarefa de preparação em
execução). O motor usa as credenciais de
MySQL e do Console OpenClaw exclusivamente pelas variáveis de ambiente
`MYSQL_*`, `OPENCLAW_CONSOLE_URL` e `OPENCLAW_CONSOLE_TOKEN`; nenhum segredo
faz parte desta configuração versionada.

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

- [ ] **Etapa 11**: Integração real com banco de dados
- [ ] **Etapa 12**: Subtarefas paralelas (paralelizar steps dentro de uma tarefa)
- [ ] **Etapa 13**: Deploy em produção e migração gradual

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
