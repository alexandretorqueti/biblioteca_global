# Mapeamento da Tela de Agentes

Subtarefa 1 da tarefa **Tela de Agentes**. Este documento registra a arquitetura
existente e o contrato recomendado para a tela/menu de agentes, sem implementar
a tela.

## Decisão de navegação

- Grupo: `projetos` (`label: "Projetos"`), definido em `config.ts`.
- Item recomendado: `id: "agentes-list"`, `label: "Agentes"`, `path: "agentes"`,
  `icon: "smart_toy"`.
- Tela: cadastro genérico (`kind: "cadastro"`) sobre o resource `agentes`.
- Convenção de grid: mostrar somente `id`, `nome`, `modelo` e `ativo`; manter
  `descricao`, identificadores técnicos e timestamps fora da grid por meio de
  `gridVisible: false`/`hiddenColumns`.

O projeto já usa essa convenção para `projetos_captados` e resources filhos em
`config.ts`. As telas customizadas usam `componentId` estável e `useApi()`;
para o CRUD de agentes, o cadastro genérico é aderente ao padrão atual.

## Modelo e vínculo

O modelo atual em `schema.ts` é `agentes`:

| Campo | Regra/papel |
| --- | --- |
| `id` | bigint autoincremental, chave primária |
| `nome` | varchar(150), obrigatório e único; no código atual recebe o ID do OpenClaw |
| `modelo` | varchar(100), obrigatório |
| `descricao` | texto opcional; pode receber o nome amigável retornado pelo console |
| `ativo` | booleano, obrigatório, padrão `true` |
| `createdAt`, `updatedAt` | timestamps de controle |

O vínculo operacional é `projetos_captados.agenteId -> agentes.id`, com `ON
DELETE SET NULL`, conforme `schema.ts`. O motor resolve a identidade que abre
a sessão com:

```text
COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug)
```

Esse campo `openclaw_agent_id` aparece nas migrations e nas queries do
`motor-v2`, mas não está declarado no objeto `agentes` de `schema.ts`. Portanto,
a tela não deve inventar ou editar esse campo até o schema/migration canônico
ser alinhado.

## Integração OpenClaw existente

O backend já possui um proxy server-side em `GerenteAgentesService`:

- `GET /api/gerenteagentes/agentes/openclaw`: consulta
  `${OPENCLAW_CONSOLE_URL}/api/agents` e retorna `{ id, name, model?, status? }`.
- `POST /api/gerenteagentes/agentes/sincronizar`: cria/atualiza o espelho local
  em `agentes`, por nome/ID do OpenClaw, sem enviar o token ao navegador.
- Ambos estão protegidos por `JwtAuthGuard`, `ProjectScopeGuard`, `RolesGuard`
  no controller e por `@Roles('admin', 'gerente')` nos endpoints.

O padrão de transporte é `useApi().http.request(..., { auth: "access" })`, já
usado por `PromptsScreen`, `DashboardScreen` e `ModelSelectionScreen`.

### Contrato funcional recomendado para a tela

1. Carregar os registros locais via cadastro `agentes`.
2. Oferecer ação explícita **Sincronizar com OpenClaw**, chamando
   `POST /gerenteagentes/agentes/sincronizar`.
3. Exibir o retorno `{ criados, atualizados, total }` e recarregar a grid.
4. Usar `GET /gerenteagentes/agentes/openclaw` apenas para prévia/diagnóstico
   ou comparação, não para expor credencial nem substituir o espelho local.
5. O vínculo ao projeto continua sendo editado no campo `agenteId` de
   `projetos_captados`, cujo `multipleChoice` já aponta para o resource
   `agentes` em `config.ts`.

## Permissões e escopo

- Sincronização OpenClaw: somente `admin` e `gerente`, já definido no
  controller.
- Leitura/CRUD do resource local: deve seguir a autorização do cadastro
  genérico da plataforma; não há neste projeto uma rota CRUD específica de
  agentes nem uma definição local de RBAC para esse resource.
- A tela deve usar autenticação de acesso e não chamar o Console OpenClaw
  diretamente.

## Inconsistências que devem ser resolvidas antes da implementação

Há documentação histórica conflitante com o estado atual:

- `CONTRATOS_API.md` v1.2 descreve `__openclaw_agentes__` somente leitura,
  sem tabela local, e `projetos_captados.agenteId` como string.
- O `config.ts`, `schema.ts`, controller, service e migrations posteriores
  atuais descrevem/implementam uma tabela local `agentes`, sincronização e
  `projetos_captados.agenteId` numérico.
- As migrations `0005`/`0006` removem a tabela/vínculo antigos, enquanto
  `0017` pode recriar o vínculo se a tabela existir. Isso precisa de uma
  decisão de fonte canônica antes de adicionar novas migrations.

Para a implementação da Tela de Agentes, a premissa adotada neste mapeamento é
o estado executável atual (resource local + sincronização server-side), por ser
o que `config.ts`, `schema.ts`, `api/` e `motor-v2/` efetivamente consomem.

## Escopo da próxima subtarefa

Implementar no projeto apenas: item de menu em `config.ts`, cadastro/tela
conforme a decisão acima, testes correspondentes e, se necessário, a
formalização do contrato CRUD. Não alterar configurações do OpenClaw nem
projetos externos ao `gerenteagentes`.
