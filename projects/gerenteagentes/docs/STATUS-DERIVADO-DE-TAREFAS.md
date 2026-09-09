# Status derivado das tarefas

## Contexto

O status atual da tarefa é gravado e atualizado por vários fluxos do Motor.
Isso permite incoerências, por exemplo uma tarefa aparecer como `ready` mesmo
quando uma subtarefa ainda está em execução.

A tarefa já possui fatos suficientes para expressar sua situação real:

- existência e estado das subtarefas;
- sessão de análise e clarificação pendente;
- bloqueio ativo;
- pausa explícita;
- integração de código;
- solicitação e resultado de deploy.

A proposta é tratar esses fatos como fonte de verdade e calcular o status
exibido e operacional a cada consulta. O Motor deixa de precisar coordenar uma
segunda verdade independente em `tarefas.status`.

## Criação e início

O estado `draft` será eliminado.

- Toda tarefa nova nasce em `planned`.
- `planned` significa que a tarefa existe, mas ainda não foi autorizada a
  iniciar.
- Ao iniciar uma tarefa sem plano, o Motor cria a sessão do analista e ela
  aparece como `analyzing`.
- Ao iniciar uma tarefa que já possui plano, ela passa a ser elegível para a
  fila e, havendo subtarefas pendentes, aparece como `ready`.

## Regras de cálculo

O status é calculado por prioridade. A primeira condição verdadeira determina
o estado apresentado pela API e pela tela.

1. `awaiting_clarification`
   - existe pergunta pendente do analista que exige decisão do Alexandre.
   - não se infere apenas pela última mensagem; deve existir um registro
     estruturado de clarificação pendente.

2. `blocked`
   - existe bloqueio ativo e não resolvido que impede o fluxo.

3. `analyzing`
   - existe sessão de análise em execução e ainda não há plano persistido.

4. `running`
   - ao menos uma subtarefa está em `running`, `delivered` ou `verifying`.

5. `deployed`
   - o deploy da versão aprovada foi confirmado com sucesso.

6. `completed`
   - todas as subtarefas estão em `verified` ou `superseded`;
   - a integração necessária foi confirmada;
   - ainda não há deploy confirmado.

7. `ready`
   - há ao menos uma subtarefa pendente elegível ou aguardando dependências;
   - não existe subtarefa ativa, bloqueio ou clarificação pendente.

8. `planned`
   - não há subtarefas e a tarefa ainda não iniciou análise;
   - ou não existe plano executável após edição administrativa do plano.

## Pausa

Pausa não precisa criar outro status de negócio.

O campo factual `paused_at` impede a fila de selecionar a tarefa, mesmo que o
estado calculado pelas subtarefas seja `ready`. A interface pode exibir
"Pausada" como condição visual complementar, sem criar ambiguidade no fluxo.

Ao retomar, `paused_at` é removido. A próxima consulta calcula o estado real:
`ready`, `analyzing`, `awaiting_clarification` ou outro aplicável.

## Dependências e correções

Dependências são dados da subtarefa, não um status da tarefa. Uma subtarefa
pendente que depende de outra ainda não aprovada mantém a tarefa em `ready`,
mas não é selecionável pela fila até que todas as dependências estejam em
`verified` ou `superseded`.

Subtarefas corretivas criadas pelo analista permanecem pendentes até a origem
estar em estado terminal aprovado. Enquanto existir qualquer corretiva
pendente, a tarefa calculada volta a `ready`.

## Exclusão e preservação de histórico

Excluir uma subtarefa não exige ajuste manual de status. O cálculo usa o
conjunto atual de subtarefas.

Exemplo:

```text
1 verified + 3 pending = ready
exclusão da verified
3 pending = ready
```

Porém, uma subtarefa `verified` não deve ser apagada fisicamente quando possuir
histórico, cobertura de requisito, entregas, commits ou dependentes. Nesses
casos a operação deve:

- ser recusada quando quebraria uma dependência; ou
- marcar a subtarefa como `superseded`, preservando auditoria e rastreabilidade.

Subtarefas em execução não podem ser excluídas diretamente; primeiro devem ser
pausadas ou canceladas de modo controlado.

## Impacto técnico

O Motor deve alterar fatos transacionais — estado da subtarefa, bloqueio,
clarificação, pausa, integração e deploy — e expor uma função única de cálculo
do status da tarefa para API, fila e interface.

Durante a migração, `tarefas.status` pode permanecer como campo de
compatibilidade ou índice materializado. Ele não será atualizado por telas nem
por fluxos concorrentes. Se mantido, somente o calculador central poderá
recalculá-lo após uma mutação factual.

O histórico deve registrar os eventos causais reais, como "subtarefa aprovada",
"bloqueio criado", "clarificação solicitada" e "deploy confirmado". Uma linha
de mudança de status pode ser derivada desses eventos para fins de visualização,
sem virar nova fonte de verdade.

## Critérios de aceite para implementação

1. Nenhuma tela ou fluxo externo atualiza o status da tarefa diretamente.
2. API, fila e interface usam o mesmo calculador de status.
3. Inserir, excluir, aprovar ou corrigir subtarefas reflete imediatamente no
   status calculado.
4. `paused_at` impede execução automática sem criar status concorrente.
5. Dependências múltiplas impedem seleção até todas as origens aprovarem.
6. Exclusão preserva auditoria e não pode quebrar dependências.
7. Os casos `ready` com execução ativa e `completed` com pendências são
   impossíveis pelo cálculo central.

## Registro de implementação

Em 2026-09-09, os comandos de pausar, retomar e aguardar recurso foram
migrados para alterar exclusivamente o fato `paused_at`. A alteração manual
de `tarefas.status` pela API foi bloqueada. A tela deve reler o detalhe após
essas ações e usar o status calculado, exibindo a pausa como condição
complementar.

Na continuação da migração, foi criada a migration `0029_task_runtime_facts`:
`analysis_started_at`, `integration_confirmed_at` e os terminais
administrativos passaram a ser fatos em `task_runtime_facts`; bloqueios agora
possuem `resolved_at`. O coordenador, a fila, a recuperação de deploys e o
reconciliador usam esses fatos e não persistem mais transições em
`tarefas.status`. O campo legado permanece apenas para leitura de registros
anteriores à migration.
