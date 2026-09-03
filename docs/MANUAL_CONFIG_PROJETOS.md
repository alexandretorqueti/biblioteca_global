# Manual operacional de configuração de projetos

Guia autocontido para criar e editar projetos CRUD da Biblioteca Global v2. O
modelo de dados é `projects/<slug>/schema.ts`; a navegação versionada é
`projects/<slug>/config.ts`. Os exemplos seguem `projects/documentacao` e
`projects/gerenteagentes`.

## 1. Config versionada versus corrente

`projects/<slug>/config.ts` é a configuração BASE, versionada com o código e
usada no provisionamento. O core guarda a configuração CORRENTE em
`database/schema.ts`, coluna JSON `projetos.config`; no primeiro provisionamento
ela começa como a base acrescida das telas derivadas do schema. Alterar uma não
substitui automaticamente a outra: mantenha a decisão registrada nas duas.

Não existe GET público de configuração. A web resolve o slug em
`apps/web/src/project/registry/projects.ts`, valida com
`geradorSistemaConfigSchema` e monta o runtime em
`apps/web/src/project/ProjectContext.tsx`. Não crie endpoint HTTP para config
nem coloque HTTP em componentes; uma futura fonte corrente pode ser trocada
nesse contexto.

## 2. Estrutura e slug

```text
projects/<slug>/
  schema.ts              # fonte única das tabelas
  config.ts              # menu/base versionada
  migrations/            # SQL e migrations/meta gerados pelo Drizzle
  screens/               # telas custom, quando houver
  src/index.ts  drizzle.config.ts  package.json  tsconfig.json
```

O slug começa com letra minúscula e contém apenas `a-z`, números e hífen. O
banco físico é sempre derivado do id: projeto `42` usa `projeto_42`, nunca um
nome recebido no payload.

## 3. GeradorSistemaConfig, menus e telas

O contrato Zod está em `packages/shared/src/config.ts`. Uma base mínima é:

```ts
export const config: GeradorSistemaConfig = {
  app: { name: "Nome do projeto", logo: "folder" },
  groups: [{ id: "cadastros", label: "Cadastros", items: [{
    id: "clientes-list", label: "Clientes", path: "clientes", icon: "people",
    screen: { kind: "cadastro", resource: "clientes" },
  }] }],
}
```

Cada group é uma seção e cada item é uma rota. IDs e paths devem ser estáveis;
ícones são nomes resolvidos pelo mapa, não ReactNodes.

### Tipos de tela

- `cadastro`: CRUD interno. `resource` é o nome real de `mysqlTable("...")`,
  como `projetos_captados`, mesmo quando a variável é `projetosCaptados`.
  `fields`/`overrides` são opcionais e o schema-tools deriva a base.
- `custom`: tela React específica, identificada apenas por `componentId`, que
  deve existir em `apps/web/src/project/registry/customScreens.tsx`.
- `external`: REST fora do schema, com `baseUrl`, `method` e `pathTemplate`;
  pode ter `dataPath`, `query`, detalhe, edição e `actions`. Não use external
  para um CRUD que o schema interno atende.

`overrides` controla somente apresentação (`hiddenColumns`, `columnLabels`,
`columns`, `newLabel`). `actions` são globais; `rowActions` são por linha e
podem usar `:id`. Cada action tem `id`, `label`, `method` e `path`; `confirm` é
opcional.

### childRoutes

Uma `childRoute` cria navegação contextual a partir de uma linha pai e declara
`id`, `label`, `targetResource` e `filterField`. Assim, `tarefas` com
`filterField: "projetoId"` lista somente as tarefas do projeto clicado. Pode
ter `title`, fields, overrides, actions, rowActions, `defaultOrderBy` e novas
childRoutes. `componentId` opcional abre uma tela custom no lugar da grid.

`children` (master-detail com `childResource`/`fkField`) não é o mesmo que
`childRoutes` (rota, filtro e configuração hierárquica). O exemplo completo de
navegação está em `projects/gerenteagentes/config.ts`.

## 4. schema.ts, annotations e CRUD derivado

Declare as tabelas Drizzle no `projects/<slug>/schema.ts`. O backend coleta os
exports pelo `apps/api/src/modules/crud/schema-registry.ts`; todo resource da
config precisa estar nessa whitelist. A conexão é obtida em
`apps/api/src/modules/crud/project-db.factory.ts` pelo projeto do token.

`packages/schema-tools/src/gerar-config.ts` adiciona uma tela cadastro para
cada tabela ainda não referenciada na base. `packages/schema-tools/src/gerar-fields.ts`
deriva tipo,
label, obrigatoriedade e options de enum; ignora primary key, autoincremento e
campos gerados. Não se cria um segundo schema na config.

Use annotations para apresentação de formulário, indexadas pelo nome REAL da
tabela e coluna:

```ts
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
export const annotations = {
  clientes: { nome: { label: "Nome", fullWidth: true, maxLength: 150 } },
} satisfies FormAnnotationsPorTabela
```

Se um tipo de coluna não for suportado, defina `type` na annotation e corrija
o modelo/validação; não duplique validação manualmente.

### Inferência automática de FK (displayField)

Campos terminados em `Id` com `reference` no schema Drizzle são automaticamente
convertidos em combos de relacionamento (`type: "multipleChoice"`) pelo
`schema-tools` durante a geração da config. A coluna "legível" da tabela
referenciada é resolvida por heurística, na seguinte ordem de prioridade:

1. **Candidatos nomeados** (primeiro que existir): `nome`, `name`, `titulo`,
   `title`, `label`, `descricao`, `description`
2. **Primeira coluna string** (varchar/text/char) da tabela referenciada
3. **Fallback para `id`** com warning logado no console

O resultado aparece na config gerada como:

```ts
{
  name: "condominioId",
  type: "multipleChoice",
  multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }
}
```

**Override manual sempre vence:** se o `config.ts` do projeto declara
explicitamente um field com `type: "multipleChoice"` e `multipleChoice.displayField`,
a heurística não é aplicada — o valor manual é preservado. Da mesma forma,
qualquer annotation com `type` explícito (ex.: `{ type: "text" }`) impede a
inferência.

A função `inferirFk(tabela, coluna)` em `packages/schema-tools/src/inferir-fk.ts`
é exportada publicamente para uso em ferramentas de build e validação.

## 5. Migrations, registries e provisionamento

Depois de alterar o schema, gere e revise SQL e `migrations/meta`:

```bash
npm run db:generate:documentacao
# para outro projeto, use seu projects/<slug>/drizzle.config.ts
```

O `drizzle.config.ts` aponta para schema e migrations. Em
`apps/api/src/modules/projetos/provisioner.service.ts`, o provisionamento
valida slug, cria `projeto_<id>`, concede acesso e aplica as migrations. O
registry de schemas deve listar cada projeto implantável.

`POST /api/provision/project` é idempotente e recebe `{ email, nome?,
projetoNome, projetoSlug? }`; cria/reutiliza usuário, cria/reutiliza projeto e
vincula o usuário como admin. Exige `Authorization: Bearer <PROVISION_TOKEN>`;
é token de serviço, não endpoint público de navegador.

Em `apps/web/src/project/registry/projects.ts`, importe a config:

```ts
import { config as clientesConfig } from "../../../../../projects/clientes/config"
export const projectConfigs = { clientes: clientesConfig }
```

Para tela custom, importe o componente de `projects/<slug>/screens/` e registre
exatamente o mesmo `componentId` em
`apps/web/src/project/registry/customScreens.tsx`. Registre as telas no boot
com `registrarTelasCustom()`; config e registry mudam juntos. Referências reais:
`projects/documentacao/screens/DocumentationScreen.tsx` e
`projects/gerenteagentes/screens/`.

## 6. API, auth e escopo por token

O prefixo `/api` é configurado em `apps/api/src/bootstrap.ts`.

| finalidade | endpoint | proteção |
| --- | --- | --- |
| login | `POST /auth/login` | público |
| projeto | `POST /auth/select-project` | refresh token |
| sessão | `GET /auth/me` | access token |
| CRUD leitura | `GET /:resource`, `GET /:resource/:id` | access + escopo |
| CRUD escrita | `POST /:resource`, `PUT /:resource/:id`, `DELETE /:resource/:id` | admin/gerente/operador |
| provisionamento | `POST /provision/project` | token de serviço |

`refresh`/`logout` usam o refresh global; `select-project` emite access token
curto com `{ sub, projetoId, perfil }`. `JwtAuthGuard` e `ProjectScopeGuard`
derivam o projeto do token: nunca aceite `projetoId` do body/query para escolher
database. `visualizador` lê, mas não escreve. A UI usa apenas
`packages/api-client` (`createDataSource`); não faça fetch na UI. Rotas
específicas vêm antes do CRUD genérico em `apps/api/src/app.module.ts`.

## 7. Exemplo completo mínimo executável como referência

```ts
// projects/clientes/schema.ts
import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import type { FormAnnotationsPorTabela } from "@biblioteca-global/schema-tools"
export const clientes = mysqlTable("clientes", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement(),
  nome: varchar("nome", { length: 150 }).notNull(),
})
export const annotations = {
  clientes: { nome: { label: "Nome", fullWidth: true } },
} satisfies FormAnnotationsPorTabela
```

```ts
// projects/clientes/config.ts
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
export const config: GeradorSistemaConfig = {
  app: { name: "Clientes", logo: "people" },
  groups: [{ id: "principal", label: "Principal", items: [
    { id: "clientes", label: "Clientes", path: "clientes", screen: {
      kind: "cadastro", resource: "clientes", title: "Clientes",
      childRoutes: [{ id: "enderecos", label: "Endereços",
        targetResource: "enderecos", filterField: "clienteId" }],
    } },
    { id: "manual", label: "Manual", path: "manual",
      screen: { kind: "custom", componentId: "clientes-manual" } },
  ] }],
}
```

Crie `projects/clientes/migrations/` via Drizzle; registre o schema em
`apps/api/src/modules/crud/schema-registry.ts`, a config em
`apps/web/src/project/registry/projects.ts` e `clientes-manual` em
`apps/web/src/project/registry/customScreens.tsx`. Se `enderecos` existir no
schema, o `targetResource` é validado pela whitelist e o filtro é automático.
Sem necessidade de UX específica, remova o item manual e seu registro.

## 8. Regras explícitas de reutilização

1. Reutilize `AuthPanel`, login, refresh, seleção de projeto e usuários; não
   crie auth, senha, refresh ou tabela de usuários por projeto.
2. Reutilize CRUD genérico, `createDataSource` e contracts shared; não crie
   controller ou endpoint para CRUD que `resource` + schema resolvem.
3. Reutilize `packages/ui` (`GeradorSistema`, `Cadastro`, `DynamicForm`,
   `ExternalScreen`, menus e layout). Custom só quando a UX exige comportamento
   fora desses componentes.
4. Mantenha HTTP em `packages/api-client`; tela custom usa runtime/bundle.
5. Mudanças de dados nascem em `schema.ts`; migration, fields e config são
   gerados. Overrides refinam apresentação e não inventam campos.
6. Preserve a API pública e valide resource, slug, paths, actions e componentId.

## 9. Checklist de entrega

- [ ] schema, annotations e config usam nomes reais e contratos Zod
- [ ] SQL e `migrations/meta` gerados e revisados
- [ ] schema registry, project registry e custom-screen registry atualizados
- [ ] cadastro/custom/external e childRoutes estão corretos
- [ ] auth, usuários, CRUD e componentes existentes foram reutilizados
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`

O teste documental em `docs/__tests__/manual-config.spec.ts` falha se estas
seções, caminhos ou o snippet mínimo forem removidos.
