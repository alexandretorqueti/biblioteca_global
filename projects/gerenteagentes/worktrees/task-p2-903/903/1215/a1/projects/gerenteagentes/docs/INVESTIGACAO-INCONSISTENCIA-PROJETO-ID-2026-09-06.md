# Investigação — inconsistência de `projeto_id` entre CRUD e Motor

Data: 2026-09-06

## Sintoma confirmado

Ao criar uma tarefa no escopo de plataforma `gerenteagentes`, o CRUD recebe
`projeto_id=1`. No banco operacional, esse ID é a linha de
`projetos_captados` com slug `biblioteca-global`. O CRUD compara esse slug com
o slug do projeto presente no token (`gerenteagentes`) e responde:

> projeto_id=1 aponta para "biblioteca-global", mas o escopo atual é
> "gerenteagentes". Use o projeto_id correto de projetos_captados.

A mensagem nasce em `apps/api/src/modules/crud/crud.service.ts`, não no Motor.

## Diagnóstico

O sistema mistura três identificadores semanticamente diferentes:

1. `core.projetos.id = 640`: identifica o aplicativo `gerenteagentes` na
   plataforma e determina o banco `projeto_640` e o escopo do token.
2. `projetos_captados.id`: identifica um projeto administrado pelo Gerente de
   Agentes dentro de `projeto_640`; é a FK correta de `tarefas.projeto_id`.
3. `projetos_captados.plataforma_projeto_id`: vincula o projeto administrado ao
   respectivo `core.projetos.id` quando ele já foi provisionado.

`640` não é, por definição, o ID do Gerente de Agentes em
`projetos_captados`. Os testes de `NovaTarefaScreen` usam `640` como opção do
combo e esperam `projeto_id=640`, mascarando essa diferença de namespaces.

## Inconsistências encontradas

### 1. A UI oferece valores que o CRUD rejeita

`NovaTarefaScreen` e `TaskMonitorScreen` carregam todas as linhas ativas de
`GET /gerenteagentes/projetos_captados`, sem restringir o combo ao slug do
token. Assim, `biblioteca-global` (`id=1`) é uma seleção válida na tela.

O CRUD, porém, só aceita a tarefa quando
`projetos_captados.slug === projeto.slug` do token. Como o token sempre está no
aplicativo `gerenteagentes`, qualquer tarefa destinada a outro projeto
administrado é rejeitada. Isso contradiz a função do Gerente de Agentes como
control plane de vários projetos.

### 2. A regra do CRUD conflita com fluxos documentados e existentes

O próprio sistema cria tarefas de setup executadas por `biblioteca-global` e a
documentação registra tarefas `task-biblioteca-*` vinculadas a
`projetos_captados.id=1`, embora a API esteja no banco/escopo `gerenteagentes`.
Logo, igualdade entre o slug do projeto administrado e o slug do aplicativo do
token não é uma invariável válida para todo o domínio.

### 3. A validação do Motor não equivale à do CRUD

No `TaskCoordinator.enqueueTask`, `task.projectSlug` e `project_slug` são
obtidos pelo mesmo `JOIN tarefas.projeto_id -> projetos_captados.id`. Esse slug
é passado como `expectedSlug` para `validateProjectId`. A comparação, portanto,
é circular: salvo corrupção interna, o valor sempre coincide consigo mesmo.

O Motor valida existência, agente e a exceção de setup, mas não possui uma
segunda fonte independente que expresse o projeto pretendido. Por isso, mover
a regra entre CRUD e Motor alterna a camada que falha sem resolver o contrato.

### 4. O cliente HTTP reforça a ambiguidade de nomes

O `api-client` proíbe `projetoId` em bodies autenticados porque esse nome era
reservado ao escopo da plataforma vindo do token. Para a FK de negócio de
`tarefas`, as telas passaram a enviar `projeto_id` em snake_case. Isso funciona
tecnicamente, mas mantém dois conceitos diferentes com praticamente o mesmo
nome e permite novos desvios entre tela, CRUD e Motor.

### 5. Cobertura atual aceita IDs irreais e não cobre o contrato integrado

- Testes da tela usam `projeto_id=640`, confundindo o ID do core com o ID de
  `projetos_captados`.
- Testes do CRUD usam fixtures em que `projetos_captados.id=1` tem slug
  `gerenteagentes`, diferente dos dados reais conhecidos.
- Testes da policy do Motor validam a função isoladamente, mas não demonstram
  que o slug esperado veio de fonte independente.
- Não há teste de contrato único cobrindo token `gerenteagentes` + seleção de
  um projeto administrado + criação + start no Motor.

## Causa-raiz

A causa-raiz é de modelagem/contrato: o mesmo termo “projeto” representa o
tenant/aplicativo da Biblioteca Global e o projeto operacional administrado
pelo Gerente de Agentes. Uma defesa global do `api-client` e uma comparação de
slug do CRUD foram reutilizadas num caso em que o aplicativo
`gerenteagentes` precisa legitimamente operar projetos filhos.

O valor `projeto_id=1` apenas tornou essa contradição visível. Trocar `1` por
outro número pode contornar uma criação específica, mas não corrige o sistema.

## Direção de correção recomendada

Definir um contrato único antes de alterar código:

- `platformProjectId`/`tenantProjectId`: somente `core.projetos.id`, sempre
  derivado do token e usado para escolher banco/config.
- `managedProjectId` (persistido como `tarefas.projeto_id` por compatibilidade):
  somente `projetos_captados.id`, enviado explicitamente ou capturado pela rota
  hierárquica.
- Autorizar o `managedProjectId` pela existência no banco do tenant, estado
  ativo e configuração/agente exigidos pelo tipo da tarefa — não por igualdade
  com o slug do tenant.
- Se houver operações realmente restritas ao próprio projeto, expressar essa
  regra por tipo de operação/tarefa, não como regra global de criação.
- Passar ao Motor um `expectedManagedProjectSlug` independente (persistido no
  comando/envelope ou resolvido da rota/autorização) ou remover a comparação
  circular e assumir a FK validada como fonte canônica.
- Corrigir fixtures para IDs reais por namespace e acrescentar teste E2E do
  fluxo CRUD -> banco -> start -> Motor para projeto próprio, projeto filho e
  tarefa de setup.

## Verificações executadas

- Repositório oficial limpo em `base-desenvolvimento` antes da investigação.
- Código-fonte da API em execução responde na porta 3003; endpoint protegido
  confirmou autenticação obrigatória. A consulta autenticada aos dados/logs
  não pôde ser feita porque o SSH do ambiente retornou `Permission denied`.
- Execução dirigida de Vitest: 166 testes passaram e 60 falharam. As falhas
  foram `Invalid hook call` em cópias de testes encontradas nos diretórios
  `wt-motor-p0`, indicando descoberta indevida de worktrees pelo runner; isso é
  um problema ambiental/de configuração adicional, não evidência contra o
  diagnóstico. Os testes existentes de policy/CRUD passaram, demonstrando
  justamente que suas fixtures isoladas não capturam a inconsistência real.

## Implementação aplicada

Após autorização do Alexandre, a criação de tarefas passou a ser uma operação
específica do domínio em `GerenteAgentesController`, registrada antes do CRUD
genérico. O contrato público usa `managedProjectId`; `projeto_id` continua
aceito somente como compatibilidade com a navegação hierárquica existente.

A API agora valida o projeto operacional por existência, estado ativo e agente
vinculado no banco selecionado pelo token. Não compara mais seu slug com o slug
do tenant. Dependências também precisam pertencer ao mesmo projeto operacional.

O Motor mantém a FK persistida como fonte canônica e deixou de passar ao gate
um `expectedSlug` obtido do mesmo JOIN. A policy ainda aceita um slug esperado
quando algum chamador futuro realmente tiver uma fonte independente.

Novos `external_id` usam `task-p<managedProjectId>-<tarefaId>`, evitando o nome
enganoso `task-biblioteca-*` e respeitando o limite de 64 caracteres. IDs já
persistidos continuam válidos e não foram migrados.
