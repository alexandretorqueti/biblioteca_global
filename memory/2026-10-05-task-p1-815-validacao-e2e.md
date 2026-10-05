# 2026-10-05 — task-p1-815 / subtarefa 1026 — validação E2E (motor-v3-work)

## Decisão

Validação integrada **parcial — implementação incompleta nesta branch**. Sem alteração de código.

## Validações estáticas executadas

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ⚠️ Falha em `apps/api` e `projects/gerenteagentes` — erros **preexistentes** em `gerenteagentes.service.ts` (motor-v2 dist não compilado) e `isa-chat.service.ts` (campo `origem` faltando). Arquivos de tratamento de erro compilam sem erro. |
| `npm run lint` (arquivos da tarefa) | ✅ 0 erros |
| `npm test` | ✅ 1471 testes passam (142 arquivos), 0 falhas |
| `npm run build` | ✅ web, api, isa-chat constroem |
| `git diff --check` | ✅ limpo |

## Diferenças de implementação (branch motor-v3-work vs motor-v2)

Esta branch (`motor-v3-work/integration-task-p1-815`) tem uma implementação **incompleta** em relação à branch de integração `motor-v2/task-p1-815/integracao`:

### 1. Sem política `erroReportavel`
O `ApiExceptionFilter` registra **TODOS** os erros, incluindo 404, 401, 403, 409, 429. O arquivo `packages/shared/src/error-report.ts` (que define `erroReportavel()` e `montarEndpointCanonico()`) **não existe** nesta branch.

**Evidência:** `api-exception.filter.ts` não importa nem chama `erroReportavel()` — apenas verifica `projetoId` e `endpoint`.

**Impacto no critério de aceite:** O teste do filtro (`api-exception.filter.spec.ts`) confirma que um 400 `BadRequestException("Campo inválido")` **gera tarefa** — isto viola o requisito "Ignore erros como 404, ou outros que não indiquem erro real no código."

### 2. Sem `montarEndpointCanonico`
O filtro envia o caminho cru (`request.route?.path`) sem normalização. IDs numéricos e UUIDs não são normalizados para `:id`, o que significa que `/clientes/12` e `/clientes/34` geram endpoints diferentes — a deduplicação por endpoint **não funciona** para o mesmo recurso com IDs diferentes.

### 3. Sem módulo `POST /api/erros`
Não existe `apps/api/src/modules/erros/` (controller, service, module). O front não tem canal dedicado para reportar erros — o registro depende exclusivamente do filtro no back. Os contratos `packages/shared/src/error-report.ts` e `packages/api-client/src/error-report.ts` também não existem.

### 4. Sem `resolverProjetoCaptado`
O repositório usa `projetoId` diretamente do request como `tarefas.projeto_id`. Na branch motor-v2, há mapeamento de `projetoId` (plataforma) para `projetos_captados.id` (catálogo do Gerente de Agentes). Aqui esse mapeamento não existe — o `projetoId` da plataforma vai direto na FK, o que pode violar a constraint.

### 5. Título errado (desvio conhecido)
`tituloDoErro()` retorna `"Erro de API: <endpoint>"` (linha 49). O correto é `"Detecção automática de Erro: <endpoint>"`. A correção existe em `base-desenvolvimento` (commit `90ef575c`) mas não foi merged para esta branch.

## Bloqueio ambiental

Docker indisponível (`docker: not found`). E2E com containers não executável.

## Conclusão

A implementação nesta branch é uma **versão simplificada** que cumpre parcialmente o objetivo (cria tarefas no banco para erros de API com deduplicação por endpoint e liberação por deploy succeeded), mas falha nos seguintes critérios de aceite:

- ❌ **404 não gera tarefa** — viola: o filtro registra todos os erros
- ❌ **Título correto** — viola: usa "Erro de API:" em vez de "Detecção automática de Erro:"
- ❌ **Endpoint canônico** — viola: sem normalização, deduplicação incompleta
- ❌ **Módulo dedicado para o front** — ausente
- ✅ **Deduplicação por endpoint ativo** — presente no repositório
- ✅ **Liberação após deploy succeeded** — presente no SQL

A implementação completa está na branch `motor-v2/task-p1-815/integracao` (validada com 47 testes específicos e todos os critérios de aceite atendidos).
