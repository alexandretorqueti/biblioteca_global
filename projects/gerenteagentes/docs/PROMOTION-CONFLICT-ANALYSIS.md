# Análise automática de conflito de promoção

## Objetivo

Quando o merge da branch de uma tarefa para a branch-base falha por conflito,
o Motor mantém a tarefa bloqueada, mas passa a investigar o conflito sozinho.
A primeira versão automatiza o diagnóstico; ela não altera arquivos, não cria
commit e não publica uma resolução sem autorização humana.

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
- `PromotionConflictAnalyzer`: envia as evidências ao analista do projeto.
- `PromotionConflictPolicy`: interpreta confiança e recomendação sem autorizar
  merge automático.
- `PromotionConflictRepository`: claim atômico, auditoria e retry limitado.
- `PromotionConflictOrchestrator`: execução assíncrona e reconciliação.

## Garantias

- A árvore da base não é usada para simular o merge.
- O worktree temporário é removido mesmo quando Git ou analista falham.
- Uma análise falha pode ser retomada uma vez; depois permanece registrada.
- Conflitos entre subtarefas, build/testes, deploy e erros genéricos do Git não
  entram neste fluxo.
- A tarefa continua bloqueada até a decisão e resolução humana.

## Visibilidade

O endpoint de detalhe da tarefa expõe `promotionConflictAnalysis`. A tela
**Acompanhar Tarefa** mostra status, arquivos, confiança, erro e o relatório
completo associado ao bloqueio.

