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
