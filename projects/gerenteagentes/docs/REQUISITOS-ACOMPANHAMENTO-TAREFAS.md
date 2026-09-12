# Requisitos — acompanhamento de tarefas

Registro de 2026-09-03 para as tarefas do projeto `biblioteca-global`.

## Atualização em tempo real

Tarefa `#761` (`task-biblioteca-761`): substituir o polling periódico da tela
de acompanhamento pela conexão WebSocket já existente. Eventos devem atualizar
o estado das tarefas em tempo real, incluindo criação, edição, exclusão,
transições de status e demais interações necessárias. A implementação deve
controlar a inscrição e a limpeza da conexão, além de tratar desconexão e
reconciliação do estado local.

O contrato normativo dessa projeção está em
[`CONTRATO-REALTIME-MAPA.md`](./CONTRATO-REALTIME-MAPA.md), incluindo snapshot
HTTP, envelope WebSocket, eventos aceitos, deduplicação e recuperação por
replay/snapshot.

## Chat da tarefa no acompanhamento

Tarefa `#762` (`task-biblioteca-762`): mostrar o chat da tarefa selecionada
abaixo da grade de subtarefas. A interface deve ter histórico rolável, campo de
mensagem, envio e respostas em tempo real, com experiência de chat de IA. A
sessão deve permanecer aberta enquanto viável para sustentar conversa
sequencial; troca de tarefa, reconexão, histórico e erros precisam ser tratados.

## Mapa vivo do fluxo de tarefas

Requisito aprovado em 2026-09-06: substituir a busca manual status por status
por um **Mapa Vivo da Operação** como experiência principal do acompanhamento.

- Cada estação representa uma etapa operacional e exibe sua quantidade de tarefas.
- As fichas das tarefas ficam visíveis dentro da estação e abrem o detalhe ao clique.
- Setas comunicam os caminhos possíveis do fluxo.
- Mudanças de status destacam o deslocamento e a chegada da tarefa.
- Uma engrenagem animada identifica estados em que a IA está trabalhando.
- Bloqueios, falhas, espera humana e correções possuem estações distintas.
- A busca por número/ID ou título destaca a tarefa em sua posição atual.

Primeira versão implementada em `screens/TaskFlowMap.tsx`, integrada à tela
`screens/TaskMonitorScreen.tsx`. Evoluções funcionais serão adicionadas depois
da validação desta base visual.

### Melhorias de layout entregues (2026-09-10, tarefa 801/971)

#### 1. Hierarquia e estrutura visual
- **Cabeçalho impactante:** ícone `AccountTreeRounded` + título "Mapa Vivo da Operação" (h6, weight 800) + badge "AO VIVO" pulsante (CSS animation `badge-pulse`) + separador visual com gradiente.
- **Métricas rápidas no topo:** total de tarefas | em andamento | concluídas hoje | bloqueadas (destaque vermelho quando >0).
- **Estações com identidade visual:** ícones representativos por estação (📝 Rascunhos, 🔍 Em análise, ⚙️ Em execução, ✅ Concluídas, 🚀 Deployadas, ⏸️ Aguardando, 🔧 Correção, ⚠️ Atenção, 🚫 Encerradas) + borda superior colorida (4px) + contador em badge circular com fonte monoespaçada (Roboto Mono) + gradiente sutil de topo para base.
- **Cards informativos:** avatar do projeto (letra + cor determinística) + barra lateral de prioridade (4px: vermelho=alta, laranja=média, verde=baixa) + tempo relativo ("há 2h", "há 1d") + mini barra de progresso para tarefas em execução.
- **Tooltip da tarefa:** não aparece ao passar o mouse na ficha inteira; é acionado somente ao passar o mouse no ícone de informações (`i`). Exibe apenas as cinco primeiras linhas da descrição, truncando o conteúdo maior, e mantém as informações complementares de projeto, prioridade e última atualização.

#### 2. Fluxo e movimento
- **Conexões SVG animadas:** linhas com gradiente em movimento (`stroke-dashoffset` animado) + pontas chevron ("arrow with tail") + efeito "rio" intensificado quando há tarefas se movendo.
- **Animações suaves:** slide-in na chegada, pulsação em tarefas ativas (scale 1.0→1.02→1.0), glow effect em tarefas processadas pela IA, fade in/out ao entrar/sair de estações. Respeita `prefers-reduced-motion`.

#### 3. Informação contextual
- **Dashboard compacto:** total de tarefas ativas + mini gráfico de barras por fase (barras coloridas por tone) + tempo médio de execução + tarefas bloqueadas em destaque.
- **Filtro integrado ao topo (substitui a combo):** barra de busca + chips de status (Em execução, Bloqueadas, Concluídas) + dropdown de projeto + chips de prioridade (alta, média, baixa) + contador "X de Y tarefas" + botão "Limpar filtros". Tecla Esc limpa todos os filtros.
- **Legenda interativa no rodapé:** chips clicáveis (🟢 Sucesso, 🟡 Atenção, 🔴 Perigo, 🔵 Ativo) que destacam tarefas do tone correspondente.

#### 4. Interatividade e usabilidade
- **Toggle compactar/expandir:** mostra só contadores (sem cards) quando compacto.
- **Expansão de estação:** clique no header expande mostrando todas as tarefas (padrão: slice 3).
- **Navegação por teclado:** estações com `tabIndex=0` + `role="group"` + `aria-label` descritivo + Enter/Space para expandir + cards de tarefa focáveis com Enter para selecionar.

#### 5. Polimento visual
- **Paleta sofisticada:** tons mapeados por tone (neutral, active, success, warning, danger) + gradientes sutis + sombras em camadas.
- **Tipografia refinada:** título 28px weight 800 + contadores em fonte monoespaçada + hierarquia clara.
- **Espaçamento generoso:** padding interno 2.5 + spacing entre estações 2 + borderRadius 3.
- **Modo escuro:** otimizado via `BibliotecaThemeProvider themeMode="dark"`.

#### 6. Responsividade
- **Mobile-first:** layout vertical em telas pequenas (estações empilhadas) + scroll horizontal com scroll-snap para estações laterais em mobile.
- **Bottom sheet:** Drawer âncora bottom para detalhe da tarefa em mobile (com `keepMounted` para testes).

#### 7. Performance percebida
- **Skeleton loaders:** skeleton das estações enquanto carrega (`carregando=true`).
- **Progressive loading:** estações aparecem em sequência com fade-in escalonado (60ms entre cada).

#### Decisões e omissões
- **Prioridade derivada do status:** não há campo de prioridade no banco; a prioridade é derivada deterministicamente do status da tarefa (alta: blocked/failed/motor_fix; média: analyzing/running/paused/ready/awaiting_clarification; baixa: draft/planned/completed/deployed/cancelled/finalizada/deployada/aborted). Ver `screens/taskFlowHelpers.ts`.
- **Drag-and-drop removido:** o status é derivado de fatos operacionais do motor, não é editável pelo usuário. Portanto, drag-and-drop não faz sentido.
- **Filtro "Responsável" não implementado:** o backend ainda não expõe campo de responsável nas tarefas. Omitem-se deliberadamente.
- **Mini-mapa opcional:** não implementado (complexidade alta para benefício marginal).
- **Swipe entre estações:** substituído por scroll-snap CSS (mais simples e performático).
- **Campo de busca da combo antiga:** removido da tela pai (`TaskMonitorScreen`) pois os filtros agora estão integrados ao topo do mapa (`TaskFlowMap`).

#### Arquivos modificados
- `screens/TaskFlowMap.tsx` — componente principal do mapa com todas as melhorias visuais.
- `screens/taskFlowHelpers.ts` — funções puras para prioridade, tempo relativo, avatar e métricas.
- `screens/TaskMonitorScreen.tsx` — integração dos filtros, correção de hooks order, bottom sheet.
- `screens/__tests__/TaskFlowMap.test.tsx` — 70+ testes cobrindo todas as melhorias.
- `screens/__tests__/taskFlowHelpers.test.ts` — testes das funções puras.
- `docs/REQUISITOS-ACOMPANHAMENTO-TAREFAS.md` — esta documentação.

### Evolução: 10 tarefas por quadro, rolagem e paginação infinita (2026-09-09, tarefa 802)

Cada quadro/estação do Mapa Vivo passou a exibir **10 tarefas visíveis** por vez (antes: 3),
com barra de rolagem vertical e paginação infinita client-side.

- **Container rolável:** cada estação possui um container com `data-testid="flow-scroll-{stationId}"`,
  `maxHeight: 360px` e `overflowY: "auto"`, permitindo rolagem vertical quando o número de tarefas
  excede a altura visível.
- **Paginação infinita client-side:** ao rolar até o final do container (threshold de 8px), mais 10
  tarefas são carregadas incrementalmente (`visibleCount += PAGE_SIZE`). A lista completa já vem da
  API `GET /gerenteagentes/tarefas-com-status` (sem paginação de backend); a paginação é puramente
  visual, para evitar renderizar centenas de cards de uma vez.
- **Busca reseta paginação:** quando o termo de busca muda, `visibleCount` volta para `PAGE_SIZE`
  (10), garantindo que o usuário veja sempre o primeiro lote do resultado filtrado.
- **Constante `PAGE_SIZE = 10`:** definida no topo do `TaskFlowMap.tsx`, usada tanto para o estado
  inicial de `visibleCount` quanto para o incremento no `handleScroll`.
- **Nota:** a lista completa de tarefas já é retornada pela API sem paginação; a paginação infinita
  é uma otimização de renderização front-end, não uma mudança de contrato com o backend.
