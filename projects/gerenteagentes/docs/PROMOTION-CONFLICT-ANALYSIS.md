# Análise automática de conflito de promoção

## Objetivo

Quando o merge da branch de uma tarefa para a branch-base falha por conflito,
o Motor mantém a tarefa bloqueada e inicia uma recuperação controlada. Ele
reproduz o conflito, entrega os três lados ao Monitor e tenta resolvê-lo em
um worktree descartável. A base só é promovida depois de o merge estar limpo
e os gates configurados do projeto passarem.

## Gatilhos

1. **Imediato:** `TaskCoordinator` recebe `promotion.kind === "conflict"`,
   persiste o bloqueio e agenda o orquestrador.
2. **Recuperação:** cada pump procura bloqueios de promoção ainda ativos. Isso
   cobre reinício do processo e bloqueios legados.

Os dois gatilhos usam `PromotionConflictOrchestrator`. Um fingerprint formado
por tarefa, commits e arquivos conflitantes impede duplicação entre instâncias
ou reinícios.

## Módulos

- `PromotionConflictDetector`: aceita somente conflito tarefa → base.
- `PromotionConflictEvidenceCollector`: reproduz o merge em worktree temporário
  e coleta os estágios ancestor/base/task.
- `PromotionConflictAnalyzer`: fallback de diagnóstico para compatibilidade.
- `PromotionConflictResolver`: cria a branch de resolução, aciona o Monitor
  no worktree temporário, valida marcadores/diff e executa build/testes.
- `PromotionConflictPolicy`: interpreta confiança e recomendação sem autorizar
  merge automático.
- `PromotionConflictRepository`: claim atômico, auditoria e retry limitado.
- `PromotionConflictOrchestrator`: execução assíncrona, reconciliação e
  promoção somente após a resolução verde.

## Garantias

- A árvore da base não é usada para simular o merge.
- O worktree temporário é removido mesmo quando Git ou analista falham.
- Uma análise falha pode ser retomada uma vez; depois permanece registrada.
- O Monitor nunca recebe permissão para push nem para alterar a base. A
  promoção final usa o lock de integração já existente no `TaskCoordinator`.
- Se o Monitor não eliminar todos os conflitos, se os gates falharem ou se a
  base avançar antes da promoção, a tarefa continua bloqueada com a evidência.
- Conflitos entre subtarefas, build/testes, deploy e erros genéricos do Git não
  entram neste fluxo.
- A tarefa só é desbloqueada depois de a resolução realmente entrar na base;
  nesse momento o Motor registra `integration_confirmed` e enfileira deploy.

## Visibilidade

O endpoint de detalhe da tarefa expõe `promotionConflictAnalysis`. A tela
**Acompanhar Tarefa** mostra status, arquivos, confiança, erro e o relatório
completo associado ao bloqueio.
