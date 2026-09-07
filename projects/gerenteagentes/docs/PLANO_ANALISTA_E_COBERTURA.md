# Plano detalhado do analista

O Motor envia a descrição integral da tarefa ao analista. Não existe mais um
limite fixo de 4.000 caracteres nem uma instrução para minimizar a quantidade
de subtarefas.

Quando a definição estiver clara, o analista deve responder com:

- `subtarefas`: cada uma com uma responsabilidade principal, escopo detalhado,
  critérios verificáveis, entregáveis, requisitos cobertos e dependências;
- `requirements`: todos os requisitos identificados, com IDs `REQ-*`;
- `coverage`: matriz que liga cada requisito às sequências responsáveis.

O Motor valida a resposta antes de gravá-la. Planos sem campos obrigatórios,
com critérios genéricos, requisitos sem cobertura, referências inválidas ou
dependências cíclicas são rejeitados e seguem para nova tentativa/escada.

`tarefas.plan_coverage`, `subtarefas.deliverables` e
`subtarefas.requirements_covered` preservam a auditoria do plano aceito.
O prompt final do analista também é gravado em `prompts_execucoes`, incluindo
a origem da composição e o tamanho do contexto recebido.
