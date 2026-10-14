# Verificação direta pelo Analista

Tarefas com tipo `verificacao` e descrição clara são analisadas diretamente pelo Analista. O resultado é estruturado no contrato `verification` e persistido como mensagem `analyst` no chat da tarefa.

Esse fluxo não cria subtarefa, sessão DEV ou worktree. Quando houver ambiguidade, o Analista usa `perguntas`; a resposta do responsável é retomada pelo chat da tarefa.

Subtarefas legadas classificadas como `analysis`, `no_code_change` ou `external_operation` continuam sem deploy quando não alteram o Git. Se uma delas gerar diff, a evidência de alteração impede a conclusão simplificada e ela segue o gate normal de verificação, commit e integração antes do encerramento.
