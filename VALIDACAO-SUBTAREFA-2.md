# Validação da Subtarefa 2 — Aceitar evento de chat da tarefa e publicação best-effort

## Critérios de aceite

### ✅ 1. realtimeEventTypeSchema e realtimeIngressEventSchema aceitam task.chat.message.created

**Evidência:** Teste adicionado em `packages/shared/src/__tests__/realtime.test.ts`:

```typescript
it("aceita evento de chat da tarefa (task.chat.message.created)", () => {
  const chatEvent = {
    ...envelope,
    type: "task.chat.message.created",
    payload: {
      id: 453,
      tarefaId: 42,
      role: "user",
      texto: "Mensagem de teste",
      createdAt: "2026-10-11T10:00:00.000Z",
    },
  }
  expect(realtimeIngressEventSchema.safeParse(chatEvent).success).toBe(true)
})
```

**Resultado:** Teste passa ✓ (15 testes em `realtime.test.ts`)

### ✅ 2. As duas emissões existentes continuam usando task.chat.message.created

**Locais no código:**
- Linha ~1856 em `gerenteagentes.service.ts` (após commit da mensagem do usuário)
- Linha ~1935 em `gerenteagentes.service.ts` (após resposta do analista)

**Validação:** Ambas as chamadas mantêm `type: 'task.chat.message.created'` e chegam ao canal task quando a publicação funciona.

### ✅ 3. Exceção de RealtimeService.publicar é capturada sem alterar resposta HTTP

**Implementação:** Try/catch adicionado em ambas as chamadas, seguindo o padrão de `publicarEventoRealtime`:

```typescript
try {
  this.realtime?.publicar({
    eventId: randomUUID(),
    occurredAt: createdAt.toISOString(),
    source: 'gerenteagentes.chat',
    projectId: Number(tarefa.projetoId),
    taskId: tarefaId,
    type: 'task.chat.message.created',
    payload: { ... },
  });
} catch (error) {
  this.logger.warn(`Falha ao publicar evento realtime do chat da tarefa ${tarefaId}: ${error instanceof Error ? error.message : String(error)}`);
}
```

**Evidência:** Teste automatizado em `gerenteagentes.service.chat-realtime.spec.ts`:

```typescript
it('retorna 2xx mesmo quando publicar lança exceção após commit da transação', async () => {
  // Mock do publicar lançando exceção
  mockRealtime.publicar.mockImplementation(() => {
    throw new Error('Evento realtime inválido');
  });

  // A chamada não deve lançar exceção — o try/catch deve capturar
  const resultado = await service.adicionarMensagemChatTarefa(
    projeto as any,
    tarefaId,
    texto,
  );

  // Verifica que a mensagem foi criada e retornada (2xx)
  expect(resultado).toBeDefined();
  expect(resultado.id).toBe(453);
  expect(resultado.tarefaId).toBe(tarefaId);
})
```

**Resultado:** Teste passa ✓ (log mostra: `WARN [GerenteAgentesService] Falha ao publicar evento realtime do chat da tarefa 974: Evento realtime inválido`)

### ✅ 4. Testes automatizados dos pacotes afetados

**packages/shared:**
```
✓ packages/shared/src/__tests__/realtime.test.ts (15 tests)
✓ packages/shared/src/__tests__/model-selection.test.ts (3 tests)
✓ packages/shared/src/__tests__/config.test.ts (129 tests)
✓ packages/shared/src/__tests__/chat.test.ts (5 tests)
✓ packages/shared/src/__tests__/lgpd.test.ts (6 tests)

Test Files  5 passed (5)
     Tests  158 passed (158)
```

**projects/gerenteagentes/api:**
```
✓ projects/gerenteagentes/api/__tests__/gerenteagentes.service.chat-realtime.spec.ts (2 tests)
✓ projects/gerenteagentes/api/__tests__/gerenteagentes.controller.task-create.spec.ts (6 tests)
✓ projects/gerenteagentes/api/__tests__/gerenteagentes.service.modelos-console.spec.ts (6 tests)
✓ projects/gerenteagentes/api/__tests__/gerenteagentes.service.analyst-sessions.spec.ts (7 tests)
... (10 arquivos de teste, 39 testes totais)

Test Files  10 passed (10)
     Tests  39 passed (39)
```

**apps/api:**
- Typecheck: `npx tsc --noEmit` — sem erros relacionados às mudanças
- Testes de realtime: `realtime-mutation-publisher.test.ts` — passa (não afetado por esta subtarefa)

## Arquivos modificados

1. **packages/shared/src/realtime.ts**
   - Adicionado `"task.chat.message.created"` ao enum `realtimeEventTypeSchema`

2. **packages/shared/src/__tests__/realtime.test.ts**
   - Adicionado teste para validar evento `task.chat.message.created`

3. **projects/gerenteagentes/api/gerenteagentes.service.ts**
   - Linha ~1856: try/catch na publicação após commit da mensagem do usuário
   - Linha ~1935: try/catch na publicação após resposta do analista

4. **projects/gerenteagentes/api/__tests__/gerenteagentes.service.chat-realtime.spec.ts** (novo)
   - Teste: POST retorna 2xx mesmo quando publicar lança exceção
   - Teste: POST publica evento com tipo correto quando funcionar

## Padrão seguido

A implementação segue o padrão já existente de `publicarEventoRealtime` (linha ~3117):

```typescript
publicarEventoRealtime(evento): void {
  if (!this.realtime) {
    this.logger.warn('RealtimeService não disponível — evento realtime não publicado');
    return;
  }
  try {
    const envelope: RealtimeIngressEvent = { ... };
    this.realtime.publicar(envelope);
  } catch (error) {
    this.logger.error(`Falha ao publicar evento realtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

A diferença é que as chamadas de chat usam `this.logger.warn` (não `error`) porque a falha de publicação não impede o funcionamento do sistema — a mensagem já foi persistida e a resposta HTTP deve ser 2xx.

## Notas

- **Nenhum tipo existente foi removido ou renomeado** — apenas adicionado `task.chat.message.created` ao catálogo
- **Contrato servidor→cliente inalterado** — mensagens JSON com campo "type" continuam funcionando
- **Logs em pt-BR** conforme exigido
- **Sem commit** conforme instrução do motor
