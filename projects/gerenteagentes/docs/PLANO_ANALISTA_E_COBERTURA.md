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

## Transporte de descrições e contrato

Descrições extensas são enviadas ao analista em blocos numerados de até 6.000
caracteres, na mesma sessão, antes do pedido de análise. O primeiro e o último
bloco possuem marcadores explícitos (`INICIO DA DESCRICAO` e
`FIM DA DESCRICAO`), e cada bloco precisa ser confirmado pelo agente. O pedido
final informa a quantidade de blocos e o tamanho total esperado.

O contrato de saída enviado ao analista contém as três partes da versão ativa
em `prompts_contratos_versoes`: instruções, JSON Schema e exemplo válido. Se a
resposta não puder ser interpretada, o Motor mantém a mesma sessão e envia uma
nova tentativa com o erro do parser e o contrato completo. A escada de modelos
só avança quando essa correção na sessão atual não resolve a incompatibilidade.
