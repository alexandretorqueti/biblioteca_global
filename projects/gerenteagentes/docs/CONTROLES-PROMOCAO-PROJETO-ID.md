# Controles de promoção e `projeto_id`

Decisão de 2026-09-03: uma promoção manual nunca constitui evidência de código.
O motor exige `workspace_commit_sha` antes de aceitar integração ou concluir a
tarefa pai. O comando `recover mark-integrated` também passa pelo mesmo gate;
sem commit ele falha e mantém a subtarefa/tarefa bloqueada, registrando o motivo
no fluxo de recuperação.

Tarefas criadas pela API para `tarefas` devem apontar para a linha de
`projetos_captados` cujo `slug` corresponde ao escopo atual. A criação rejeita
ids inexistentes ou de outro projeto, e o endpoint de entrada do Motor repete a
validação (incluindo agente vinculado), porque o banco sozinho só garante que a
FK existe — não que ela pertence ao projeto correto.

## Incidente — criação pela tela de projetos (2026-09-03)

Ao enviar `POST /api/gerenteagentes/tarefas` com `projeto_id` numérico, a API
retornou `projeto_id inválido`. A causa identificada em
`apps/api/src/modules/crud/crud.service.ts` é a ordem da conversão de chaves:
o corpo `projeto_id` é convertido para a propriedade Drizzle `projetoId`, mas
a validação posterior ainda consulta `valores.projeto_id`. O valor lido é,
portanto, `undefined` mesmo quando a requisição contém um ID válido.

A correção pertence à API da Biblioteca Global: a validação deve ler
`valores.projetoId` (ou executar antes da conversão), preservando a checagem de
existência e de escopo em `projetos_captados`.
