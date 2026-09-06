# Requisitos — acompanhamento de tarefas

Registro de 2026-09-03 para as tarefas do projeto `biblioteca-global`.

## Atualização em tempo real

Tarefa `#761` (`task-biblioteca-761`): substituir o polling periódico da tela
de acompanhamento pela conexão WebSocket já existente. Eventos devem atualizar
o estado das tarefas em tempo real, incluindo criação, edição, exclusão,
transições de status e demais interações necessárias. A implementação deve
controlar a inscrição e a limpeza da conexão, além de tratar desconexão e
reconciliação do estado local.

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
