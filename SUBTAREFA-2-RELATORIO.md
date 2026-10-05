# Subtarefa 2 — Frontend: exibir diagnóstico de conflito e integrar o botão 'Ver Conflitos'

## Status: ✅ CONCLUÍDA

## Implementação

### 1. Backend — Novos endpoints (API)

**Arquivo:** `projects/gerenteagentes/api/gerenteagentes.controller.ts`

Adicionados dois novos endpoints:

- **GET `/gerenteagentes/tarefas/:id/promotion-conflict-analysis`**
  - Retorna a análise de conflito de promoção persistida para a tarefa
  - Inclui evidência completa: branches, commits, arquivos com excerpts (ours/theirs/base)
  - Inclui resoluções já tomadas (se houver)

- **POST `/gerenteagentes/tarefas/:id/promotion-conflict-analysis/resolve`**
  - Persiste a decisão de resolução de conflito por arquivo (ours/theirs/both)
  - Body: `{ resolutions: Array<{ path: string; decision: 'ours' | 'theirs' | 'both' }> }`
  - Atualiza o `evidence_json` na tabela `promotion_conflict_analyses` com as resoluções

**Arquivo:** `projects/gerenteagentes/api/gerenteagentes.service.ts`

Implementados os métodos:
- `getPromotionConflictAnalysis()` — busca e retorna dados estruturados do conflito
- `resolvePromotionConflict()` — persiste decisões de resolução por arquivo

### 2. ConflictViewer — Componente aprimorado

**Arquivo:** `projects/gerenteagentes/screens/ConflictViewer.tsx`

Mudanças:
- Adicionado suporte a `persistedData` (dados persistidos de `promotion_conflict_analyses`)
- Adicionado suporte a `onResolveConflict` callback para resolver conflitos
- Adicionados botões de resolução por arquivo: "Aceitar Ours", "Aceitar Theirs", "Aceitar Both"
- Diferenciação visual entre conflitos reais (kind: mechanical/semantic) e modificações simultâneas (kind: unknown)
- Exibição de progresso de resolução (ex: "2/5 resolvidos")
- Ícone de check para arquivos já resolvidos

**Novas interfaces exportadas:**
- `PromotionConflictData` — tipo para dados persistidos
- `MergeConflict.isRealConflict` — flag para diferenciar conflitos reais

### 3. TaskCodeViewer — Integração com dados persistidos

**Arquivo:** `projects/gerenteagentes/screens/TaskCodeViewer.tsx`

Mudanças:
- Adicionada prop `persistedConflictData` para receber dados do conflito persistido
- Quando há dados persistidos, o botão "Ver Conflitos" usa esses dados em vez de simular do zero
- Adicionado handler `handleResolveConflict` que chama o endpoint POST de resolução
- Estado local `localResolutions` para atualizar a UI imediatamente após resolver
- Passa `persistedData` e `onResolveConflict` para o `ConflictViewer`

### 4. OperationMapScreen — Exibição de diagnóstico estruturado

**Arquivo:** `projects/gerenteagentes/screens/OperationMapScreen.tsx`

Mudanças:
- Interface `Detail.task` atualizada para incluir `promotionConflictAnalysis`
- `renderSummaryTab()` agora exibe diagnóstico completo quando `blockInfo.kind === 'merge_conflict'`:
  - O que aconteceu (conflito de merge no deploy)
  - Etapa (promoção para branch de integração)
  - Branch de origem e destino
  - Commit da tarefa
  - Lista de arquivos conflitantes
  - Ação necessária (rebase/manual merge)
  - Botão "Ver Conflitos" que abre o TaskCodeViewer
- Falhas que não são merge_conflict continuam com a exibição atual (blockInfo.excerpt)
- Passa `persistedConflictData` para o `TaskCodeViewer`

### 5. Feed Operacional — Tratamento de evento merge_conflict

**Arquivo:** `projects/gerenteagentes/screens/operational-feed-adapter.ts`

Mudanças:
- `feedItemFromEnvelope()` agora trata especificamente eventos `task.blocked` com `blockReason === 'merge_conflict'`
- Gera item do feed com:
  - `event: 'merge_conflict'`
  - `reason`: resumo legível (ex: "Conflito de merge: 3 arquivo(s) conflitante(s) ao integrar branch1 → branch2")
  - `payload`: dados estruturados (conflictFiles, baseBranch, taskBranch, taskCommit, command)
- Feed operacional exibe o diagnóstico resumido em tempo real

### 6. Testes

**Arquivo:** `projects/gerenteagentes/screens/__tests__/ConflictViewer.test.tsx` (novo)

Testes implementados:
- ✅ Exibe dados persistidos quando disponíveis
- ✅ Exibe botões de resolução quando onResolveConflict é fornecido
- ✅ Chama onResolveConflict ao clicar em botão de resolução
- ✅ Diferencia conflitos reais de modificações simultâneas
- ✅ Exibe progresso de resolução
- ✅ Exibe mensagem de sucesso quando não há conflitos

**Resultado:** 6/6 testes passando

## Critérios de aceite — Validação

✅ **Tarefa bloqueada por merge_conflict exibe commit, branch de origem, branch de destino, arquivos conflitantes e comando no detalhe do Mapa de agentes.**
- Implementado em `renderSummaryTab()` do OperationMapScreen
- Exibe todas as informações estruturadas do conflictData

✅ **Botão 'Ver Conflitos' abre o ConflictViewer com os dados persistidos do bloqueio quando disponíveis.**
- TaskCodeViewer recebe `persistedConflictData` via prop
- Quando disponível, usa esses dados em vez de simular do zero
- ConflictViewer renderiza com os dados persistidos

✅ **ConflictViewer distingue visualmente conflitos reais (ours ≠ theirs ≠ base) de alterações simultâneas sem conflito.**
- Campo `isRealConflict` calculado a partir de `kind` (mechanical/semantic = real, unknown = modificado)
- Chips diferentes: "conflict" (vermelho) para conflitos reais, "modificado" (amarelo) para modificações simultâneas

✅ **Feed operacional exibe evento de merge_conflict com diagnóstico resumido.**
- `feedItemFromEnvelope()` trata especificamente merge_conflict
- Gera resumo legível e payload estruturado

✅ **Falhas que não são conflito continuam com exibição atual (blockInfo.excerpt).**
- `renderSummaryTab()` verifica `isMergeConflict` antes de exibir diagnóstico estruturado
- Se não for merge_conflict, usa a exibição genérica com blockInfo.excerpt

✅ **Cada arquivo conflitante exibe botões para aceitar ours/theirs/both; a resolução é persistida e reflete no status do bloqueio.**
- ConflictViewer exibe botões "Aceitar Ours", "Aceitar Theirs", "Aceitar Both" para cada arquivo
- Handler chama endpoint POST que persiste em `promotion_conflict_analyses.evidence_json`
- UI atualiza imediatamente com estado local e reflete progresso (ex: "2/5 resolvidos")

## Build e testes

- **Build:** ✅ Sucesso (apps/web, packages/ui, alpha-chat)
- **Testes:** ✅ 1074 testes passando (incluindo 6 novos testes do ConflictViewer)
- **TypeScript:** ✅ Sem erros nos arquivos modificados

## Arquivos modificados

1. `projects/gerenteagentes/api/gerenteagentes.controller.ts` — 2 novos endpoints
2. `projects/gerenteagentes/api/gerenteagentes.service.ts` — 2 novos métodos
3. `projects/gerenteagentes/screens/ConflictViewer.tsx` — suporte a dados persistidos e resolução
4. `projects/gerenteagentes/screens/TaskCodeViewer.tsx` — integração com dados persistidos
5. `projects/gerenteagentes/screens/OperationMapScreen.tsx` — exibição de diagnóstico estruturado
6. `projects/gerenteagentes/screens/operational-feed-adapter.ts` — tratamento de evento merge_conflict
7. `projects/gerenteagentes/screens/__tests__/ConflictViewer.test.tsx` — testes (novo)

## Observações

- A implementação aproveita a estrutura já existente de `promotion_conflict_analyses` (tabela, schema, motor-v3)
- O endpoint GET busca a análise mais recente da tarefa (ORDER BY created_at DESC LIMIT 1)
- O endpoint POST atualiza o `evidence_json` com as resoluções e marca status como 'resolved'
- O ConflictViewer é reutilizável: funciona tanto com dados de simulação (merge-simulation) quanto com dados persistidos
- O feed operacional já exibe eventos genericamente; o tratamento especial de merge_conflict apenas melhora a legibilidade
