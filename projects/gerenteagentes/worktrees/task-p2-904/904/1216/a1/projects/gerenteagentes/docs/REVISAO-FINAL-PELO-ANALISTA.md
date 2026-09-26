# Revisão final da tarefa pelo analista

## Objetivo

Uma tarefa não é considerada entregue apenas porque todas as subtarefas foram verificadas pelos gates técnicos. Antes da conclusão e do deploy, o mesmo analista que criou o plano deve conferir se o conjunto entregue atende ao pedido original.

Essa revisão fecha a diferença entre cada subtarefa aprovada isoladamente e a tarefa completa cumprir todos os requisitos e critérios que motivaram sua criação.

## Sessão do analista

- A sessão lógica do analista pertence à tarefa, não a uma tentativa de análise.
- Ela permanece disponível desde o planejamento até a aprovação final da tarefa.
- Esclarecimentos, plano, revisão e correções usam a mesma sessão.
- Após a aprovação final, o histórico completo é persistido no banco para auditoria. A sessão remota pode então ser arquivada ou encerrada.

## Momento da revisão

O Motor chama a revisão final somente quando todas as subtarefas planejadas estão em estado terminal aprovado (`verified` ou `superseded`) e não há subtarefas pendentes, em execução ou aguardando gate.

Antes de chamar o analista, o Motor deve fornecer evidências consolidadas:

- descrição original da tarefa e esclarecimentos respondidos;
- plano, requisitos `REQ-*`, matriz de cobertura e critérios de aceite;
- subtarefas executadas, resultados e gates;
- diff consolidado da branch de integração;
- commits e arquivos efetivamente alterados;
- resultados de build, testes e demais validações;
- correções anteriores e seus vínculos com subtarefas de origem.

O analista usa o estado real do repositório e as evidências, não apenas o resumo do desenvolvedor.

## Decisão do analista

### Aprovar a tarefa

Quando todos os requisitos e critérios de aceite estiverem atendidos, registra uma aprovação final fundamentada. A tarefa pode seguir para deploy e, após deploy confirmado, para `deployed`.

### Criar uma subtarefa de correção

Quando encontrar um desvio dentro do escopo original, o analista cria uma subtarefa corretiva. O campo `scope` deve conter:

- requisito(s) `REQ-*` e critério(s) de aceite que falharam;
- evidência objetiva do desvio: arquivo, comportamento, teste ou diff;
- correção esperada e resultado verificável;
- limite explícito: corrigir o desvio sem ampliar o escopo original.

O título identifica a subtarefa de origem, por exemplo:

```text
Correção da subtarefa #830 — validar entrega de encomenda
```

A corretiva depende da subtarefa que apresentou o erro. O Motor deve persistir essa dependência e só iniciá-la depois que a origem estiver em estado terminal aprovado. Depois que a corretiva passar pelos gates, o analista revisa novamente apenas os requisitos e evidências afetados, sem recomeçar a análise inteira.

Como há novas subtarefas pendentes, a tarefa retorna a `ready`. Esse estado já significa corretamente que existe trabalho pendente; não será criado status adicional apenas para revisão ou correção.

### Pedir decisão ao Alexandre

Se o desvio exigir ampliar, reduzir ou mudar o escopo original, o analista não cria subtarefa por conta própria. Ele envia uma mensagem no chat da própria tarefa com:

- o que foi encontrado;
- evidência e relação com o plano original;
- por que a correção seria mudança de escopo;
- a decisão necessária e opções com impactos.

A tarefa fica em `awaiting_clarification`. Após a resposta do Alexandre, o analista recebe a mensagem na mesma sessão e cria a correção autorizada, ajusta o plano ou encerra o ponto, conforme a decisão.

## Regras de segurança

- O analista não pode transformar uma revisão em nova iniciativa sem autorização explícita no chat.
- Toda corretiva precisa manter vínculo rastreável com a subtarefa e o requisito de origem.
- A evidência usada para aprovar ou reprovar permanece armazenada no histórico da tarefa.
- A revisão não substitui os gates técnicos; ela verifica aderência funcional e de escopo após os gates.
- O deploy só pode iniciar após aprovação final do analista.

## Critérios de aceite da implementação futura

1. O analista é chamado na mesma sessão antes da conclusão da tarefa.
2. A revisão recebe plano e evidências consolidadas da integração.
3. Uma reprovação dentro do escopo cria corretiva vinculada, com requisito, evidência e resultado esperado no `scope`.
4. A corretiva depende da subtarefa de origem e seu título exibe o ID dela.
5. Novas subtarefas retornam a tarefa para `ready`.
6. Ampliação de escopo gera pergunta no chat e `awaiting_clarification`.
7. A aprovação final é auditável e precede o deploy.
