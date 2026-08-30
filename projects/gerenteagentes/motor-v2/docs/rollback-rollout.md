# Rollback do Rollout — Motor v2 → v1

Procedimento para reverter o roteamento da Biblioteca para o Motor v1 caso o
motor-v2 apresente falha grave em produção. Desenhado para execução em minutos,
sem migração reversa de schema.

## Pré-condições de segurança do design

- O v2 **só acrescentou** colunas/tabelas no `projeto_640`
  (`workspace_*` em subtarefas, `execution_resources`, `execution_resource_queue`,
  `bloqueios`, `auto_start`, etc.). O v1 não lê essas colunas e não quebra com
  elas presentes.
- O roteamento é decidido exclusivamente pela variável `MOTOR_VERSION` no
  container `biblioteca-global-api` (`gerenteagentes.service.ts`): com
  `MOTOR_VERSION=v2` chama `http://127.0.0.1:3010/api/motor/*` (v2, mesmo
  container); sem ela usa `MOTOR_DEV_URL`/v1.
- Estados de tarefa usados pelo v2 (`blocked`, `analyzing`) não existem no v1;
  o passo 3 trata isso.

## Procedimento

### 1. Congelar novas execuções

```bash
# dentro do container da API da Biblioteca (ou onde o motor-v2 escuta)
curl -s http://127.0.0.1:3010/api/motor/stats
```

Anote os workers ativos. Se houver execução em andamento, decida entre esperar
a conclusão (recomendado) ou pausar via `POST /api/motor/task/:id/pause`.

### 2. Remover o roteamento v2

Remover `MOTOR_VERSION=v2` do ambiente do serviço `biblioteca-global-api`
(compose/env do serviço — alteração de infraestrutura, feita pelo Alexandre) e
reiniciar o serviço. A partir daí, motor-detail/start/pause/resume voltam ao v1.

### 3. Normalizar estados criados pelo v2

```sql
-- tarefas em estados que o v1 não conhece
UPDATE projeto_640.tarefas SET status = 'planned' WHERE status IN ('analyzing');
UPDATE projeto_640.tarefas SET status = 'ready'   WHERE status = 'blocked'
  AND EXISTS (SELECT 1 FROM projeto_640.subtarefas s WHERE s.tarefa_id = projeto_640.tarefas.id);
UPDATE projeto_640.tarefas SET status = 'planned' WHERE status = 'blocked';
-- subtarefas em voo voltam para a fila (o v1 ignora a tabela, mas mantém higiene)
UPDATE projeto_640.subtarefas SET status = 'pending'
 WHERE status IN ('running', 'verifying', 'delivered', 'rework');
-- soltar leases do v2
DELETE FROM projeto_640.execution_resources;
DELETE FROM projeto_640.execution_resource_queue;
```

### 4. Verificação pós-rollback

- `GET` do motor-detail pela Biblioteca retorna dados do v1 (porta/URL do v1).
- Nenhuma tarefa em `analyzing`/`blocked`.
- Iniciar uma tarefa de teste pelo fluxo v1 e acompanhar até o gate.

## Re-rolamento (volta ao v2)

Repor `MOTOR_VERSION=v2` e reiniciar o serviço. O motor-v2 reconcilia tarefas
órfãs na partida (ExpirationReconciler) e retoma a fila normalmente.

## Critério de acionamento

Acionar este rollback quando, em produção, ocorrer qualquer um:
- falha do publish/integração em duas tarefas consecutivas sem causa pontual;
- motor-v2 sem resposta em `health` por mais de 2 minutos após restart;
- corrupção de estado que o `scripts/recover.js` não resolve.

Após o rollback, registrar o incidente na `PENDENCIAS.md`/memória do dia com
evidência (logs estruturados: `MOTOR_LOG_FILE` do container).
