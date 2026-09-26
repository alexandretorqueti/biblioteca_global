# Checklist de equivalência — Mapa de agentes

Checklist da nova representação visual em relação ao acompanhamento legado.

## Funcionalidades

- [x] Todas as tarefas continuam acessíveis pelo mapa e pelo detalhe lateral.
- [x] Carregamento incremental das tarefas por estação permanece disponível.
- [x] Busca, projeto, status agrupado e prioridade filtram o mapa.
- [x] Seleção abre o detalhe sem navegar para outra página.
- [x] Chat, envio, estados de espera e atualização por tempo real foram preservados.
- [x] Pausar, retomar, iniciar, desbloquear e ações em massa permanecem disponíveis.
- [x] Nova tarefa, edição da tarefa e edição de subtarefa permanecem disponíveis.
- [x] Dependências de tarefa e subtarefa permanecem editáveis.
- [x] Sessões do analista e de subtarefas continuam acessíveis.
- [x] Paginação por cursor das mensagens de sessões permanece ativa ao rolar.
- [x] Logs, histórico, entregas e informações de recuperação permanecem acessíveis.

## Operação e apresentação

- [x] Estados principais e excepcionais são representados como estações do mapa.
- [x] Contadores, densidade, atividade da IA e transições são visíveis.
- [x] Tarefas deployadas não são renderizadas como uma lista ilimitada.
- [x] Status de conexão e atualização periódica permanecem visíveis.
- [x] Tema claro/escuro é respeitado pelos componentes MUI da tela e os textos permanecem legíveis.
- [x] Foco, labels, tooltips e `prefers-reduced-motion` foram mantidos na representação.
- [x] Menu “Mapa de agentes” usa rota própria e não substitui “Acompanhar Tarefa”.

## Validação executada

- `npx eslint projects/gerenteagentes/screens/OperationMapScreen.tsx projects/gerenteagentes/screens/TaskFlowMap.tsx`
- `npx vitest run projects/gerenteagentes/screens/__tests__/TaskFlowMap.test.tsx projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx`

Observação: a tela legada não foi alterada. A confirmação visual em navegador real (desktop, mobile, claro e escuro) ainda depende da execução do servidor web da Biblioteca Global.
