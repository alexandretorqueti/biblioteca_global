# Motor v2 - Sistema de Paralelismo Controlado

## Visão Geral

Motor v2 é uma reescrita do sistema de execução de tarefas do GerenteAgentes, projetado desde o início para suportar paralelismo controlado.

## Arquitetura

### Componentes Principais

1. **TaskCoordinator** (`coordinator/TaskCoordinator.ts`)
   - Seleciona tarefas elegíveis
   - Gerencia workers (até MAX_WORKERS simultâneos)
   - Coordena aquisição de recursos
   - Retoma tarefas pausadas

2. **ResourceLeaseService** (`resources/ResourceLeaseService.ts`)
   - Gerenciamento de leases de recursos
   - Aquisição transacional
   - Heartbeat e renovação
   - Fencing token para segurança

3. **WorkerLauncher** (`workers/WorkerLauncher.ts`)
   - Gerenciador de workers (placeholder)
   - Será implementado na Etapa 5

4. **Tipos e Contratos** (`shared/types/`)
   - Zero `any` - todos os tipos são explícitos
   - Contratos claros entre componentes
   - Tipos de execução, recursos e workflow

## Estrutura de Diretórios

```
packages/motor-v2/
├── src/
│   ├── coordinator/          # TaskCoordinator
│   ├── workers/              # WorkerLauncher, TaskWorker
│   ├── resources/            # ResourceLease, schema SQL
│   ├── execution/            # ExecutionContext (futuro)
│   ├── api/                  # API Fastify (futuro)
│   └── shared/
│       ├── types/            # Tipos e interfaces
│       └── utils/            # Utilitários
├── test/                     # Testes
└── package.json
```

## Recursos Gerenciados

O sistema gerencia locks para os seguintes recursos:

| Resource Key | Capacidade | Escopo | Uso |
|--------------|------------|--------|-----|
| `project:<slug>:execution` | 1 | Projeto | Execução de tarefas |
| `project:<slug>:integration` | 1 | Projeto | Merge de branches |
| `project:<slug>:deploy` | 1 | Projeto | Deploy |
| `gpu:local-model` | 1 | Global | Modelos locais (evita estouro VRAM) |
| `motor:monitor` | 1 | Global | Monitor do motor |
| `infra:mysql:3308` | 1 | Global | MySQL compartilhado |
| `infra:port:3003` | 1 | Global | Porta da API |
| `infra:port:5174` | 1 | Global | Porta do front |

## Etapas de Implementação

### ✅ Etapa 0-3: Fundação (ATUAL)
- [x] Estrutura de diretórios
- [x] Tipos e interfaces (zero `any`)
- [x] ResourceLeaseService
- [x] TaskCoordinator (básico)
- [x] Schema SQL
- [ ] Testes completos
- [ ] Integração com banco

### ⏳ Etapa 4: Monitor Motor Exclusivo
- [ ] Migrar MotorFixStep para usar ResourceLease
- [ ] Testes de lock exclusivo

### ⏳ Etapa 5: Worker Isolado
- [ ] Implementar WorkerLauncher com child_process
- [ ] Protocolo de comunicação
- [ ] Heartbeat

### ⏳ Etapa 6: Espera Orientada a Eventos
- [ ] ResourceEventBus
- [ ] ResourceWaitManager
- [ ] ResourceReconciler

### ⏳ Etapa 7: Locks por Projeto
- [ ] Substituir lock global por locks por projeto
- [ ] Integração Git com lock específico
- [ ] Deploy com lock específico

### ⏳ Etapa 8: Paralelismo Controlado
- [ ] MAX_WORKERS=2
- [ ] Semáforo de modelos locais
- [ ] Testes de paralelismo

### ⏳ Etapa 9: Subtarefas Paralelas
- [ ] SubtaskDependencyGraph
- [ ] SubtaskExecutor
- [ ] Merge sequencial

## Princípios de Design

1. **Zero `any`**: Todos os tipos são explícitos
2. **Contratos claros**: Interfaces bem definidas entre componentes
3. **Segurança first**: Fencing token, heartbeat, expiração
4. **Incremental**: Cada etapa é validável isoladamente
5. **Testável**: Testes unitários e de integração

## Configuração

```typescript
const coordinator = new TaskCoordinator(db, repository, resourceLease, {
  maxWorkers: 1,           // Será 2 na Etapa 8
  maxWorkersPerProject: 1, // Sempre 1
})
```

## Schema do Banco

Execute `src/resources/schema.sql` no banco `projeto_640` para criar as tabelas necessárias.

## Desenvolvimento

```bash
# Instalar dependências
npm install

# Typecheck
npm run typecheck

# Testes
npm test

# Build
npm run build
```

## Status

🚧 **Em desenvolvimento** - Etapa 0-3 (Fundação)

## Próximos Passos

1. Completar testes do ResourceLeaseService
2. Implementar integração real com banco
3. Testar TaskCoordinator com tarefas reais
4. Iniciar Etapa 4 (Monitor Motor)
