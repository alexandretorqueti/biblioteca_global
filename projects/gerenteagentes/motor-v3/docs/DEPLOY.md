# Motor v3 — Guia de Deploy

## Pré-requisitos

1. **Motor v2 PARADO** (decisão D1 — não religar NUNCA)
   - Verificar: `curl http://host.docker.internal:3010/api/motor/health` deve falhar
   - Se estiver rodando: `ssh -i /root/.ssh/id_ed25519 alexandre@host.docker.internal 'docker exec biblioteca-green-api-1 kill -TERM <pid>'`
   - Verificar PID: `docker exec biblioteca-green-api-1 ps aux | grep start.js`

2. **Banco MySQL acessível**
   - Container: `biblioteca-global-mysql`
   - Porta: 3308 (host)
   - Database: `projeto_640`

3. **Branch `motor-v3`** com código atualizado
   - Repo: `/data/workspace/projects/codigofonte/biblioteca-global`
   - Path: `projects/gerenteagentes/motor-v3/`

## Instalação

```bash
cd /data/workspace/projects/codigofonte/biblioteca-global/projects/gerenteagentes/motor-v3
npm install
npm run build
```

## Configuração

Criar `.env` na pasta do motor-v3:

```env
DATABASE_URL=mysql://root:root@biblioteca-global-mysql:3306/projeto_640
MOTOR_PORT=3010
```

**Nota:** O `DATABASE_URL` usa o nome do container MySQL (`biblioteca-global-mysql`) e porta interna (3306), não a porta do host (3308). Isso funciona se o motor-v3 rodar na mesma rede Docker do MySQL.

## Migração e bootstrap automáticos

O deploy blue-green aplica migrations pendentes dos projetos ativos no slot
novo, antes da troca de tráfego. O desenvolvedor só versiona o arquivo da
migration; a aplicação usa credencial privilegiada, lock MySQL e Drizzle.

O container da API executa, nesta ordem:

1. `db:migrate:gerenteagentes`, que aplica a migration canônica
   `0051_motor_v3_runtime` para claim, outbox e estado do consumidor;
2. `db:bootstrap-runtime`, somente quando `MOTOR_VERSION=v3`;
3. inicialização do processo do Motor v3.

O bootstrap usa um advisory lock MySQL para suportar blue/green. Em banco
existente, apenas valida o catálogo. Em banco vazio, cria as dez tabelas do
catálogo e popula os dados canônicos. Se encontrar schema ou catálogo
parcialmente criado, encerra o boot com diagnóstico e não apaga nem reconstrói
dados automaticamente.

Não executar `motor-v3 npm run db:migrate` no deploy. O histórico Drizzle
isolado anterior é referência de bootstrap; as estruturas compartilhadas são
governadas pelo histórico canônico de `projects/gerenteagentes/migrations`.

## Iniciar Motor v3

```bash
npm start
```

Ou em background:

```bash
nohup npm start > motor-v3.log 2>&1 &
```

## Verificar

```bash
# Health check
curl http://localhost:3010/api/motor/health

# Stats
curl http://localhost:3010/api/motor/stats

# Catálogo
curl http://localhost:3010/api/motor/catalog/events
curl http://localhost:3010/api/motor/catalog/actions
curl http://localhost:3010/api/motor/catalog/primitives
```

### Retomada de tarefas dependentes

Quando um lote de deploy termina com sucesso, o Motor v3 consulta, na mesma
transação, as tarefas do mesmo projeto que dependem das tarefas implantadas.
Ele grava `TASK_RESUME_REQUESTED` no `motor_outbox` somente para dependentes sem
pausa do usuário, sem estado terminal, sem análise em andamento e sem
subtarefas. A consulta também evita duplicar a retomada para o mesmo lote.

## Parar Motor v3

```bash
# Encontrar PID
ps aux | grep 'node dist/start.js' | grep motor-v3

# Enviar SIGTERM (graceful shutdown)
kill -TERM <pid>
```

O motor faz graceful shutdown:
1. Para Scheduler
2. Fecha API HTTP
3. Fecha pool MySQL
4. Exit 0

## Piloto D9 (Validação Progressiva)

### Fase 1: Tarefa Trivial

1. **Criar tarefa trivial** via API da biblioteca:
   - Projeto: Administrador Global (ou qualquer projeto de teste)
   - Descrição: "Mudar texto do botão 'Salvar' para 'Gravar'"
   - Agente: `administrador-global` (ou agente do projeto)

2. **Acompanhar execução**:
   - Verificar logs do motor-v3
   - Verificar worktree criado em `/data/workspace/agentes/motor-v3/worktrees/`
   - Verificar se agente respondeu com `::DONE::`
   - Verificar se build passou
   - Verificar se Bookkeeper fez commit/merge/push

3. **Se der erro**:
   - Registrar no `docs/MOTOR-V3-LOG.md`
   - Corrigir o motor-v3
   - Reiniciar motor-v3
   - Criar nova tarefa trivial (não reusar tarefa suja)

4. **Quando finalizar e fazer deploy**:
   - Avançar para Fase 2

### Fase 2: Tarefa Complexa

1. **Criar tarefa de desenvolvimento complexa**:
   - Exemplo: "Implementar CRUD de clientes com validação de CPF"
   - Mesmo processo de acompanhamento

2. **Validar**:
   - Código gerado
   - Testes passando
   - Build OK
   - Deploy enfileirado

### Fase 3: Tarefa de Verificação

1. **Criar tarefa de verificação**:
   - Exemplo: "Auditar segurança do módulo de autenticação"
   - Agente deve analisar código, identificar vulnerabilidades, gerar relatório

2. **Validar**:
   - Relatório gerado
   - Problemas identificados
   - Recomendações acionáveis

### Fase 4: Tarefa de Automação

1. **Criar tarefa de automação**:
   - Exemplo: "Configurar CI/CD para o projeto X"
   - Agente deve criar workflows, scripts, configurar ferramentas

2. **Validar**:
   - CI/CD funcionando
   - Builds automáticos
   - Deploys automáticos

### Fase 5: Tarefa Real (Alexandre)

Quando **todas as fases anteriores passarem**:
1. Avisar Alexandre via Telegram
2. Ele criará uma **tarefa real** em produção
3. Acompanhar e validar
4. Se passar → Motor v3 está pronto para produção

## Rollback (se necessário)

Se o motor-v3 falhar em produção:

1. Parar motor-v3
2. Religar motor-v2 (APENAS SE ALEXANDRE AUTORIZAR)
   - `ssh -i /root/.ssh/id_ed25519 alexandre@host.docker.internal 'docker exec biblioteca-green-api-1 bash -c "MOTOR_VERSION=v2 node projects/gerenteagentes/motor-v2/dist/start.js &"'`
3. Investigar falha no motor-v3
4. Corrigir e testar novamente

**Nota:** Rollback para v2 é último recurso. Preferir corrigir o v3.

## Monitoramento

### Logs

```bash
# Logs do motor-v3
tail -f motor-v3.log

# Logs do MySQL
docker logs -f biblioteca-global-mysql
```

### Métricas

```bash
# Executions ativas
curl http://localhost:3010/api/motor/stats | jq .activeExecutions

# Proposals pendentes
curl http://localhost:3010/api/motor/catalog/proposals | jq length
```

### Aprovar/Rejeitar Proposals (Monitor Bridge)

```bash
# Aprovar
curl -X POST http://localhost:3010/api/motor/catalog/approve/<proposalId> \
  -H 'Content-Type: application/json' \
  -d '{"reviewedBy": "admin"}'

# Rejeitar
curl -X POST http://localhost:3010/api/motor/catalog/reject/<proposalId> \
  -H 'Content-Type: application/json' \
  -d '{"reviewedBy": "admin", "reason": "Não aplicável"}'
```

## Troubleshooting

### Motor não inicia

- Verificar `.env` (DATABASE_URL correto?)
- Verificar se MySQL está rodando
- Verificar se porta 3010 está livre
- Verificar logs: `npm start` (foreground)
- Se aparecer `schema parcial do catálogo v3`, não recriar tabelas: comparar a
  lista indicada no erro com as migrations antes de corrigir o schema.

### Agente não responde com ::DONE::

- Verificar se WorkerLauncher está chamando a API do OpenClaw
- Verificar se sandbox está configurado corretamente
- Verificar logs do agente no Console OpenClaw

### Build falha após ::DONE::

- Verificar se worktree está limpo
- Verificar se dependências estão instaladas
- Verificar logs de build

### Bookkeeper falha no merge

- Verificar conflitos de merge manualmente
- Resolver conflitos no worktree
- Retry via API: `POST /api/motor/task/:id/resume`

### Scheduler detecta timeout

- Verificar se agente está travado
- Verificar logs do agente
- Verificar se sandbox está rodando

## Contatos

- **Alexandre (Telegram):** `message(action=send, channel=telegram, target=7147090795)`
- **Gerente de Agentes (este agente):** workspace `/data/workspace/projects/agentes/gerenteagentes`

## Referências

- **Spec completa:** `docs/ESPECIFICACAO.md` (18 seções)
- **Mapeamento v2→v3:** `docs/MOTOR-V2-SIMULACAO-TEXTUAL.md`
- **Log de desenvolvimento:** `docs/MOTOR-V3-LOG.md`
- **Catálogo de eventos:** `docs/CATALOGO-EVENTOS-REACOES.md`
