# Auditoria da tarefa 832 — realtime do Mapa de Agentes

Data da auditoria: 11/10/2026

## Resultado

A tarefa 832 acertou a camada de transporte: gateway WebSocket com ticket, escopo por projeto, cliente, snapshot inicial, replay e publishers pontuais. O Mapa também deixou de depender de polling periódico.

O erro foi assumir que publishers pontuais equivaleriam a cobertura de todas as mutações. A transição **Iniciar** podia remover `tarefas.paused_at` e chamar o Motor sem registrar o evento canônico `draft/paused -> planned`. Do mesmo modo, o claim atômico podia gravar `analysis_started_at` sem publicar `planned -> analyzing`. Sem um E2E real com `WsAdapter`, essa lacuna permaneceu invisível.

## Invariante vigente

Nenhuma mudança de estado operacional pode publicar diretamente de controller ou depender da lembrança de um repositório isolado. Toda escrita que altere a projeção do Mapa deve passar pela fronteira/repositório canônico, que:

1. calcula o estado derivado anterior e posterior;
2. grava a mutação e o evento na mesma transação/outbox;
3. despacha somente após o commit;
4. usa `eventId` idempotente e sequência monotônica por projeto;
5. tolera falha do ingresso sem desfazer a mutação e reenvia o mesmo evento.

`resumed` pode existir apenas como auditoria. O estado apresentado pelo Mapa após retomar é `planned` (ou o estado canônico efetivamente resolvido), nunca `resumed`.

Exceções legadas devem permanecer encapsuladas, identificadas e cobertas por teste; SQL de mudança de estado não deve ser introduzido fora do repositório/fronteira canônica.

## Evidência de fechamento

`apps/api/src/modules/realtime/__tests__/realtime.ws.e2e.spec.ts` usa o servidor Nest com `WsAdapter` real, ticket autenticado e canal `map`. O teste cobre:

- regressão da 832: o evento `planned` chega sem emissor manual no controller;
- ordem `planned -> analyzing` após claim confirmado;
- pausa/retomada e ciclo de subtarefa `pending -> running -> verified`, incluindo contadores;
- reconexão com `lastSequence`, replay incremental, sequência monotônica e deduplicação por `eventId`;
- rejeição de ticket fora do escopo do projeto.

O cliente permanece baseado em `map_snapshot` + eventos incrementais. Não foi reintroduzido polling periódico e os contratos shared/api-client não precisaram de alteração.
