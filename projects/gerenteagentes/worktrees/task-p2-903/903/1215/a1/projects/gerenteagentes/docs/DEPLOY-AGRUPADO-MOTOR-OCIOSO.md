# Deploy agrupado com o Motor ocioso

O Motor não publica mais uma tarefa imediatamente após sua integração. Tarefas
de desenvolvimento concluídas criam registros persistentes em
`deploy_requests`. O botão **Fazer deploy** usa a mesma fila.

## Regras

- A tarefa permanece `completed` enquanto o deploy estiver pendente.
- Nenhum lote começa enquanto existir worker, finalização, limpeza de worktree
  ou estado ativo de tarefa/subtarefa persistido no banco.
- Todas as solicitações pendentes do mesmo repositório entram em um único lote.
- O processo roda destacado no ServerIA e mantém o lock global com `flock`.
- Antes de recriar a API, o lote fica `running` no banco.
- O processo no host grava um marcador de sucesso ou falha em `/tmp`.
- Após reiniciar, o Motor reconcilia o marcador. Somente o sucesso muda as
  tarefas do lote para `deployed`.
- No boot e em cada ciclo, tarefas de desenvolvimento `completed` que ainda
  não possuem solicitação são recuperadas para a fila.
- Falha definitiva muda as tarefas do lote para `blocked`, registra o motivo
  em `ultima_mensagem_erro` e cria uma ocorrência em `bloqueios`. Uma tarefa
  bloqueada não entra novamente na fila automaticamente.
- Um lote sem marcador por 30 minutos é encerrado como falha, evitando estado
  `running` permanente caso o processo remoto seja interrompido.

Assim, a perda da memória do processo durante a recriação da API não perde o
estado da publicação e vários trabalhos concluídos podem ser publicados juntos.
