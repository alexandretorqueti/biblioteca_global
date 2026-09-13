# Checklist de equivalência — Mapa de agentes

Refatoração **visual** da operação. A tela antiga ("Acompanhar Tarefa",
`TaskMonitorScreen` + `TaskFlowMap`) **não foi alterada**: a nova tela
("Mapa de agentes", `OperationMapScreen` + `OperationMapCanvas`) é uma segunda
apresentação que consome **exatamente a mesma lógica/dados** (mesmos hooks,
mesmos endpoints, mesmos tipos de status).

## Arquitetura da nova visualização

- `OperationMapCanvas.tsx` — representação "Mission Control": estações em rail
  (metrô), marcadores de tarefa, densidade, exceções, workers, zoom/pan,
  filtros e as visualizações **Mapa / Lista / Atividade**.
- `OperationMapScreen.tsx` — orquestração: carrega tarefas/projetos/atividade,
  abre o detalhe em **painel lateral direito** (Drawer ~38-40%), mantém
  chat, execução, logs, histórico, edições e ações existentes.

Nenhuma regra de negócio mora no mapa. Nenhum contrato de API foi alterado.

## Funcionalidades (equivalência)

- [x] Todas as tarefas continuam acessíveis (marcador → detalhe; Lista; "ver todas" por estação).
- [x] Carregamento incremental por estação preservado (mostra até 5; expande/abre a lista para o restante).
- [x] Busca, projeto, status agrupado e prioridade filtram o mapa (com indicação visual de filtro ativo e limpeza).
- [x] Seleção abre o detalhe lateral sem navegar para outra página.
- [x] Chat, envio, estados de espera e atualização por tempo real preservados.
- [x] Pausar, retomar, iniciar, desbloquear e ações em massa permanecem disponíveis.
- [x] Nova tarefa e edições (tarefa/subtarefa) permanecem disponíveis.
- [x] Sessões do analista e de subtarefas, paginação por cursor, logs e histórico permanecem acessíveis.
- [x] Deployadas nunca viram lista ilimitada (terminal de produção com densidade + recentes + "Ver todas as N").
- [x] Estados excepcionais (Aguardando, Correção do motor, Atenção, Encerradas) acessíveis; discretos em zero, destacados quando há ocorrências.
- [x] Intervenção humana evidente (banner "N tarefa(s) precisa(m) de você" → abre a tarefa).
- [x] Workers visíveis e detalhados em popover (projeto · tarefa · fase · tempo).
- [x] Status de conexão de tempo real visível ("tempo real" / "reconectando…").
- [x] Semântica de cores preservada (prioridade nos marcadores; cor de estado por tom), sem depender só de cor (labels/tooltips/ícones).
- [x] `prefers-reduced-motion` respeitado nas animações do mapa.
- [x] Tema claro/escuro via tokens do design system (sem cores hardcoded incompatíveis).

## Validação executada

- `npx eslint projects/gerenteagentes/screens/OperationMapCanvas.tsx projects/gerenteagentes/screens/OperationMapScreen.tsx`
- `npx vitest run projects/gerenteagentes/screens` (inclui `__tests__/OperationMapCanvas.test.tsx`)
- `npx vite build` em `apps/web` (bundle íntegro, sem regressão de resolução)
- Auditoria de layout em Chromium real (1500x1000): sem overflow horizontal de página,
  6 estações do fluxo principal + terminal de produção + 4 estações de exceção
  alinhadas, modo claro e escuro renderizados sem erro.

Observação: a confirmação visual "olho no olho" continua dependendo de subir o
servidor web da Biblioteca Global; a tela legada segue intacta para comparação.
