# Procedimento Operacional — Configurações do Motor

Este documento descreve o procedimento para alterar configurações operacionais do Motor v2 através da tela CONFIGURAÇÕES.

## Visão Geral

O Motor v2 possui parâmetros operacionais configuráveis que controlam comportamento como:
- Limite de tarefas em paralelo (global e por projeto)
- Timeouts de execução (workers, build, testes, Console)
- Intervalos de polling e reconciliação
- Duração de leases de recursos

Esses parâmetros são editáveis através da tela **CONFIGURAÇÕES** no painel administrativo do GerenteAgentes.

## Acesso à Tela

1. Acesse o painel administrativo do GerenteAgentes
2. No menu lateral, clique em **CONFIGURAÇÕES**
3. A tela lista todos os parâmetros editáveis com seus valores atuais, padrões e regras de validação

## Parâmetros Editáveis

### Concorrência e Paralelismo

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.max_workers` | `1` | inteiro entre 1 e 100 | Número máximo global de tarefas de desenvolvimento em paralelo. |
| `motor.max_workers_per_project` | `1` | inteiro entre 1 e 100 | Número máximo de tarefas em paralelo por projeto. |

**Impacto operacional:**
- `max_workers`: controla quantas subtarefas de desenvolvimento podem executar simultaneamente no motor. Valores maiores aumentam throughput mas consomem mais recursos (vRAM para modelos locais, CPU, memória).
- `max_workers_per_project`: evita que um único projeto ocupe todas as vagas do motor. Útil quando há múltiplos projetos ativos.

**Recomendação:** para ambientes com modelos locais, manter `max_workers` baixo (1-2) para evitar estouro de vRAM. Para ambientes com APIs remotas, pode aumentar para 3-5 conforme capacidade do host.

### Timeouts de Execução

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.worker_timeout_ms` | `14400000` (4h) | inteiro entre 60000 e 86400000 | Tempo máximo de execução de um worker. |
| `motor.worker_silence_timeout_ms` | `600000` (10min) | inteiro entre 30000 e 86400000 | Tempo sem heartbeat antes de considerar o worker travado. |
| `motor.build_test_timeout_ms` | `300000` (5min) | inteiro entre 60000 e 3600000 | Tempo máximo para execução de build e testes unitários. |
| `motor.dependency_install_timeout_ms` | `900000` (15min) | inteiro entre 10000 e 3600000 | Tempo máximo para instalar dependências. |
| `motor.worker_shutdown_timeout_ms` | `10000` (10s) | inteiro entre 1000 e 120000 | Tempo de encerramento gracioso de workers. |

**Impacto operacional:**
- `worker_timeout_ms`: teto absoluto de execução. Se uma subtarefa exceder, é marcada como falha.
- `worker_silence_timeout_ms`: watchdog de silêncio. Se o worker não enviar heartbeat por esse período, é considerado travado e encerrado.
- `build_test_timeout_ms`: timeout para `npm run build` e `npm run test`. Valores baixos podem falhar projetos grandes; valores altos retardam detecção de falhas.
- `dependency_install_timeout_ms`: timeout para `npm ci`/`npm install`.
- `worker_shutdown_timeout_ms`: tempo de graceful shutdown antes de encerramento forçado.

**Recomendação:** ajustar `build_test_timeout_ms` conforme complexidade dos projetos. Para projetos com testes lentos, aumentar para 10-15 minutos.

### Timeouts do Console (OpenClaw)

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.console_run_absolute_timeout_ms` | `14400000` (4h) | inteiro entre 60000 e 86400000 | Tempo máximo absoluto de uma execução remota no Console. |
| `motor.console_run_idle_timeout_ms` | `600000` (10min) | inteiro entre 30000 e 86400000 | Tempo sem progresso permitido em uma execução remota. |
| `motor.console_poll_interval_ms` | `5000` (5s) | inteiro entre 1000 e 600000 | Intervalo de consulta do estado de uma execução remota. |
| `motor.console_send_timeout_ms` | `600000` (10min) | inteiro entre 10000 e 3600000 | Tempo máximo para enviar uma mensagem ao Console. |

**Impacto operacional:**
- Controlam a interação com o OpenClaw Console para execução remota de agentes.
- `console_poll_interval_ms`: valores baixos aumentam volume de chamadas ao Console; valores altos retardam detecção de conclusão.

### Recursos e Leases

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.resource_lease_ms` | `600000` (10min) | inteiro entre 30000 e 86400000 | Duração do lease de um recurso exclusivo. |
| `motor.resource_heartbeat_interval_ms` | `30000` (30s) | inteiro entre 1000 e 86400000 | Intervalo de renovação dos leases de recursos. |
| `motor.resource_event_wait_timeout_ms` | `30000` (30s) | inteiro entre 1000 e 3600000 | Tempo máximo de espera por evento de recurso. |

**Impacto operacional:**
- `resource_lease_ms`: duração do lock de recurso (ex.: execução de projeto). Deve ser maior que `resource_heartbeat_interval_ms`.
- `resource_heartbeat_interval_ms`: frequência de renovação. Deve ser menor que `resource_lease_ms` para evitar perda prematura do lock.

### Intervalos de Polling e Reconciliação

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.pump_interval_ms` | `30000` (30s) | inteiro entre 1000 e 3600000 | Intervalo de consulta da fila de tarefas. |
| `motor.reconciler_interval_ms` | `30000` (30s) | inteiro entre 1000 e 3600000 | Intervalo de reconciliação de leases e execuções órfãs. |

**Impacto operacional:**
- `pump_interval_ms`: latência para detectar novas tarefas e retomar fila. Valores baixos aumentam carga no banco.
- `reconciler_interval_ms`: frequência de limpeza de leases expirados e órfãos.

### Baseline e Confirmação

| Chave | Padrão | Regra | Descrição |
|---|---:|---|---|
| `motor.baseline_confirmation_timeout_ms` | `300000` (5min) | inteiro entre 10000 e 3600000 | Tempo máximo para confirmar o baseline. |

**Impacto operacional:**
- Timeout para validação da suíte/base antes de execução.

## Procedimento de Alteração

### Passo 1: Identificar o Parâmetro

1. Acesse a tela **CONFIGURAÇÕES**
2. Localize o parâmetro desejado na lista
3. Leia a descrição e a regra de validação

### Passo 2: Alterar o Valor

1. Edite o campo "Valor atual" com o novo valor desejado
2. Para parâmetros numéricos, certifique-se de que o valor respeita a regra de validação (intervalo mínimo/máximo)
3. Clique em **Salvar configurações**

### Passo 3: Validar

1. A tela exibe mensagem de sucesso ou erro
2. Em caso de erro, verifique a regra de validação e ajuste o valor
3. O motor lê as configurações periodicamente (refresh a cada 30s por padrão)

### Passo 4: Verificar Aplicação

Para confirmar que a alteração foi aplicada:

1. **Configurações de concorrência** (`max_workers`, `max_workers_per_project`):
   - O motor lê o valor no próximo ciclo de pump (a cada `pump_interval_ms`)
   - Novas tarefas serão limitadas pelo novo valor
   - Tarefas já em execução não são afetadas

2. **Timeouts de execução**:
   - Novas execuções usam o timeout atualizado
   - Execuções em andamento mantêm o timeout original

3. **Intervalos de polling**:
   - O motor precisa ser reiniciado para aplicar alterações em `pump_interval_ms` e `reconciler_interval_ms`
   - Alternativamente, aguarde o próximo ciclo de inicialização

## Regras de Validação

Todas as configurações são validadas antes de persistir:

- **Tipo:** number, string ou boolean (conforme definição)
- **Intervalo:** valores numéricos devem estar dentro do intervalo definido (ex.: "inteiro entre 1 e 100")
- **Atomicidade:** o lote inteiro é validado antes de qualquer alteração; se houver erro, nenhuma configuração é alterada

## Efeito de Reinicialização

- **Configurações aplicadas em runtime** (via cache do MotorConfigReader):
  - `max_workers`, `max_workers_per_project` (lidos no construtor do Motor, mas o cache é refreshado periodicamente)
  - Timeouts de execução (`worker_timeout_ms`, `build_test_timeout_ms`, etc.)
  - Timeouts do Console (`console_*_timeout_ms`)
  - Recursos e leases (`resource_*_ms`)

- **Configurações que requerem reinicialização do motor**:
  - `pump_interval_ms` (usado no `setInterval` do `start()`)
  - `reconciler_interval_ms` (usado no `setInterval` do reconciliador)

**Recomendação:** após alterar `pump_interval_ms` ou `reconciler_interval_ms`, reinicie o motor para aplicar imediatamente.

## Monitoramento

Para verificar se as configurações foram aplicadas:

1. **Logs do motor:** o motor registra as configurações carregadas na inicialização
2. **Tela CONFIGURAÇÕES:** mostra o valor atual e a data da última atualização (`atualizadoEm`)
3. **API do motor:** `GET /api/motor/health` retorna estatísticas incluindo `maxWorkers` e `maxWorkersPerProject`

## Exemplos de Uso

### Aumentar paralelismo para projetos grandes

**Cenário:** você tem múltiplos projetos ativos e quer aumentar o throughput.

1. Acesse **CONFIGURAÇÕES**
2. Altere `motor.max_workers` de `1` para `3`
3. Altere `motor.max_workers_per_project` de `1` para `2`
4. Clique em **Salvar configurações**
5. Aguarde o próximo ciclo de pump (30s por padrão)

**Resultado:** o motor agora permite até 3 tarefas em paralelo (global) e até 2 por projeto.

### Ajustar timeout de build para projetos complexos

**Cenário:** projetos com testes lentos estão falhando no gate de build/test.

1. Acesse **CONFIGURAÇÕES**
2. Altere `motor.build_test_timeout_ms` de `300000` (5min) para `900000` (15min)
3. Clique em **Salvar configurações**
4. Novas execuções usarão o timeout de 15 minutos

**Resultado:** builds e testes têm até 15 minutos para completar antes de falhar por timeout.

### Reduzir latência de detecção de novas tarefas

**Cenário:** você quer que o motor detecte novas tarefas mais rapidamente.

1. Acesse **CONFIGURAÇÕES**
2. Altere `motor.pump_interval_ms` de `30000` (30s) para `10000` (10s)
3. Clique em **Salvar configurações**
4. **Reinicie o motor** para aplicar a alteração

**Resultado:** o motor consulta a fila a cada 10s em vez de 30s.

## Solução de Problemas

### Configuração não foi aplicada

1. Verifique se o valor foi salvo corretamente na tela
2. Confirme a data de atualização (`atualizadoEm`)
3. Para `pump_interval_ms` e `reconciler_interval_ms`, reinicie o motor
4. Verifique os logs do motor para confirmar o carregamento das configurações

### Valor inválido

1. A tela exibe mensagem de erro com a regra de validação
2. Ajuste o valor para respeitar o intervalo definido
3. Tente salvar novamente

### Motor não responde após alteração

1. Verifique se os valores alterados são razoáveis (ex.: `pump_interval_ms` muito baixo pode sobrecarregar o banco)
2. Reinicie o motor
3. Se o problema persistir, reverta para os valores padrão

## Arquitetura Técnica

### Fluxo de Dados

```
Tela CONFIGURAÇÕES
  ↓ PUT /gerenteagentes/configuracoes
Controller (GerenteAgentesController)
  ↓ Service (GerenteAgentesService)
Validação (catálogo) → Persistência (tabela motor_configuracoes)
  ↓
MotorConfigReader (cache em memória, refresh periódico)
  ↓
Motor / TaskCoordinator / ResourceLeaseService / ConsoleAgentRuntimeDriver / WorkerLauncher / DependencyInstaller
```

### Componentes

- **Catálogo:** `api/motor-configuracoes.catalog.ts` e `motor-v2/src/config/motor-configuracoes.catalog.ts`
- **Schema:** `schema.ts` (tabela `motor_configuracoes`)
- **Migration:** `migrations/0027_motor_configuracoes.sql`
- **Service:** `api/gerenteagentes.service.ts` (métodos `listarConfiguracoesMotor` e `atualizarConfiguracoesMotor`)
- **Controller:** `api/gerenteagentes.controller.ts` (endpoints `GET /configuracoes` e `PUT /configuracoes`)
- **Reader:** `motor-v2/src/config/MotorConfigReader.ts` (cache com refresh periódico)
- **Tela:** `screens/ConfiguracoesScreen.tsx`
- **Consumidores:** `Motor.ts`, `TaskCoordinator.ts`, `ResourceLeaseService.ts`, `ConsoleAgentRuntimeDriver.ts`, `WorkerLauncher.ts`, `DependencyInstaller.ts`, `TaskWorker.ts`

### Cache

O `MotorConfigReader` mantém um cache em memória com refresh periódico (padrão: 30s). Isso significa:

- Alterações na tela são persistidas imediatamente no banco
- O motor lê o novo valor no próximo refresh do cache (até 30s)
- Para forçar refresh imediato, o motor pode chamar `refreshNow()` (não exposto via API)

## Segurança

- **Autorização:** apenas usuários com papel `admin` ou `gerente` podem alterar configurações
- **Validação:** todas as alterações são validadas antes de persistir
- **Auditoria:** a coluna `updated_at` registra a data da última alteração
- **Segredos:** configurações de infraestrutura (credenciais, endpoints, caminhos) não são editáveis pela tela

## Referências

- [Mapeamento de Configurações do Motor](./MAPEAMENTO-CONFIGURACOES-MOTOR.md) — lista completa de parâmetros e origens
- [Schema do Banco](../schema.ts) — definição da tabela `motor_configuracoes`
- [Migration 0027](../migrations/0027_motor_configuracoes.sql) — criação da tabela e dados iniciais
