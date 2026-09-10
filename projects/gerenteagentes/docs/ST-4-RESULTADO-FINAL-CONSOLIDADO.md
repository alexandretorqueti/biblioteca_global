# ST-4: Resultado Final Consolidado na API de Tarefas

**Data:** 2026-09-10  
**Status:** Implementado  
**Subtarefa:** 4 de "Exibir resposta final de verificações e automações no chat da tarefa"

## Contexto

Tarefas dos tipos `verificacao` e `automacao` geram um resultado final consolidado ao concluir sua execução. Este resultado é persistido na coluna `resultado_final` da tabela `tarefas` pelo motor-v2.

**Problema anterior:** O resultado final só estava acessível via endpoint `motor-detail` (proxy para o motor), o que:
1. Exigia que o motor estivesse disponível
2. Não era intuitivo para clientes que queriam apenas o resultado final
3. Misturava dados de execução (motor) com dados persistidos (banco)

## Solução Implementada

### 1. Novo Endpoint: `GET /api/gerenteagentes/tarefas/:id/resultado`

Retorna a tarefa com o resultado final consolidado diretamente do banco de dados, sem depender do motor.

**Características:**
- Para tarefas de `automacao` e `verificacao`: retorna `resultadoFinal` populado (quando disponível)
- Para tarefas de `desenvolvimento`: retorna `resultadoFinal: null`
- Não exige consulta à tabela de subtarefas
- Disponível mesmo quando o motor está offline

**Exemplo de resposta:**

```json
{
  "id": 1,
  "externalId": "task-biblioteca-1",
  "projetoId": 640,
  "titulo": "Verificar integridade do banco",
  "descricao": "Executar verificações de integridade",
  "tipo": "verificacao",
  "status": "completed",
  "resultadoFinal": {
    "status": "done",
    "summary": "Todas as verificações passaram com sucesso",
    "reason": "Integridade confirmada em todas as tabelas"
  },
  "ultimaMensagemErro": null,
  "maxRework": 3,
  "hardTimeoutMs": 3600000,
  "dependsOnTaskId": null,
  "autoStart": false,
  "planCoverage": null,
  "bootRetryCount": 0,
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:35:00Z"
}
```

### 2. Estrutura do `resultadoFinal`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `status` | string | `done` (sucesso), `need_help` (precisa ajuda), `blocked_environment` (ambiente bloqueado) |
| `summary` | string | Resumo consolidado do resultado |
| `reason` | string | Motivo ou detalhes adicionais |

### 3. Implementação Técnica

**Service (`api/gerenteagentes.service.ts`):**
- Método `obterTarefaComResultadoFinal(projeto, tarefaId)`
- Lê diretamente da tabela `tarefas` (coluna `resultado_final`)
- Parse seguro do JSON com validação de schema
- Retorna `null` para tarefas de desenvolvimento ou quando o resultado não está disponível

**Controller (`api/gerenteagentes.controller.ts`):**
- Endpoint `GET /tarefas/:id/resultado`
- Usa `ParseIntPipe` para validação do ID
- Segue o mesmo padrão de autenticação e autorização dos demais endpoints

**Motor-v2 (`motor-v2/src/database/DrizzleDb.ts`):**
- Já persistia o resultado final via `saveTask`
- Já retornava o resultado final via `getTask`
- Função `parseFinalResult` valida o schema do resultado

### 4. Compatibilidade

**Contratos existentes:**
- Endpoint `motor-detail` continua funcionando (retorna `finalResult` no objeto `task`)
- Endpoint `subtarefas` continua disponível para dados técnicos detalhados
- CRUD genérico da biblioteca não foi alterado

**Versionamento:**
- Novo endpoint segue o padrão REST existente
- Campo `resultadoFinal` é opcional (nullable)
- Clientes podem migrar gradualmente do `motor-detail` para o novo endpoint

### 5. Casos de Uso

**Cenário 1: Frontend exibe resultado final**
```typescript
const response = await fetch('/api/gerenteagentes/tarefas/1/resultado');
const task = await response.json();
if (task.resultadoFinal) {
  console.log(task.resultadoFinal.summary);
}
```

**Cenário 2: Monitoramento de tarefas concluídas**
```typescript
// Lista tarefas de verificação concluídas
const tasks = await fetch('/api/gerenteagentes/tarefas?projetoId=640&tipo=verificacao&status=completed');
// Para cada tarefa, obtém o resultado final
for (const task of tasks.items) {
  const detail = await fetch(`/api/gerenteagentes/tarefas/${task.id}/resultado`);
  console.log(detail.resultadoFinal);
}
```

**Cenário 3: Integração com chat da tarefa**
O frontend pode usar o resultado final para gerar uma mensagem consolidada no chat da tarefa, sem precisar agregar dados de múltiplas subtarefas.

## Critérios de Aceite

✅ **A API retorna o resultado final consolidado para tarefas de verificacao e automacao quando disponível**
- Implementado via `GET /tarefas/:id/resultado`
- Campo `resultadoFinal` populado para tipos `automacao` e `verificacao`

✅ **O retorno do resultado final não exige consulta da tabela de subtarefas pelo cliente**
- Resultado vem diretamente da coluna `resultado_final` da tabela `tarefas`
- Uma única chamada HTTP retorna o resultado consolidado

✅ **Os contratos existentes permanecem compatíveis ou são versionados conforme o padrão do projeto**
- Endpoint `motor-detail` continua funcionando
- Novo endpoint segue padrão REST existente
- Campo é opcional (nullable)

✅ **A API mantém acesso separado aos dados técnicos e evidências das subtarefas quando esses dados já fizerem parte do contrato existente**
- Endpoint `GET /tarefas/:id/subtarefas` continua disponível
- Endpoint `GET /tarefas/:id/motor-detail` continua disponível para dados de execução

## Testes

**Arquivos de teste criados:**
- `api/__tests__/gerenteagentes.controller.task-resultado.spec.ts`
- `api/__tests__/gerenteagentes.service.task-resultado.spec.ts`

**Cobertura:**
- Tarefa de verificação com resultado final
- Tarefa de automação com resultado final
- Tarefa de desenvolvimento (resultadoFinal = null)
- Tarefa não encontrada (NotFoundException)
- JSON inválido (resultadoFinal = null)
- Diferentes status (done, need_help, blocked_environment)

## Próximos Passos

1. **Frontend:** Ajustar `TaskMonitorScreen` para usar o novo endpoint quando apropriado
2. **Chat da tarefa:** Implementar geração de mensagem consolidada no chat baseada no resultado final
3. **Documentação:** Atualizar guias de integração para mencionar o novo endpoint

## Referências

- Schema: `schema.ts` (coluna `resultadoFinal` da tabela `tarefas`)
- Motor-v2: `motor-v2/src/database/DrizzleDb.ts` (persistência e leitura)
- Motor-v2: `motor-v2/src/coordinator/TaskCoordinator.ts` (atualização do resultado)
- Contratos: `CONTRATOS_API.md` § 3.3
