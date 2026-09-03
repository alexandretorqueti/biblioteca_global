# Manual de Desenvolvimento — Biblioteca Global v2

Este manual é a regra operacional da plataforma `biblioteca-global`. A especificação de produto continua em `POC_DEFINICOES.md`; em divergência, preserve a API pública, identifique a intenção e aplique a menor correção compatível.

## 1. Arquitetura

- Monorepo npm workspaces, Node 22+, TypeScript estrito, React 19, MUI 7, NestJS 11, Drizzle e MySQL 8.
- `packages/ui`: componentes sem HTTP.
- `packages/api-client`: única camada HTTP do frontend.
- `packages/shared`: contratos Zod-first compartilhados.
- `packages/schema-tools`: deriva formulários, validação e config do schema Drizzle.
- `apps/api`: auth, usuários, projetos e CRUD genérico.
- `apps/web`: login, seleção de projeto e `GeradorSistema`.
- `projects/<slug>`: schema, migrations, config e telas custom de cada projeto.

O banco `core` contém usuários, projetos, vínculos e refresh tokens. Cada projeto possui database físico `projeto_<id>`. O database é sempre derivado do access token; nunca aceite `projetoId` no payload de uma operação comum.

## 2. Ambiente

```bash
npm install --include=dev
cp .env.example .env
docker compose up -d --build
```

Portas padrão no host: web `5174`, API `3003`, MySQL `3308`. Dentro do compose: web `80`, API `3001`, MySQL `3306`.

Validação obrigatória antes de concluir qualquer alteração:

```bash
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

## 3. Criar um componente UI

1. Procure um componente semelhante em `packages/ui/src/components` e reutilize contratos, tema e padrões de teste.
2. Defina props estritas e acessíveis; não use `any` nem transporte HTTP.
3. Implemente o menor componente composável possível.
4. Exporte explicitamente em `packages/ui/src/index.ts`.
5. Adicione teste em `packages/ui/src/components/__tests__` e demo executável em `projects/documentacao/screens`.
6. Rode teste, typecheck e build do pacote e do monorepo.

## 4. Evoluir um componente

- API pública exportada é compatibilidade obrigatória. Prefira props opcionais e defaults que preservem o comportamento anterior.
- Mudança incompatível exige decisão arquitetural registrada e versão major.
- Reproduza o problema em teste antes da correção.
- Não introduza dependência se MUI, React ou utilitário interno já resolverem.

## 5. Convenção de annotations

O `schema.ts` Drizzle é a fonte de verdade. Metadata visual fica em um mapa exportado `annotations`, porque colunas reconstruídas pelo Drizzle não preservam decorators de instância.

```ts
export const annotations = {
  produtos: {
    nome: { label: "Nome", fullWidth: true, maxLength: 150 },
    descricao: { label: "Descrição", type: "textarea" },
  },
} satisfies FormAnnotationsPorTabela
```

Chaves de tabela e campo devem corresponder ao export e à coluna do schema. Tipo não inferível precisa de `type` explícito. A config salva é validada contra o schema; campo inexistente deve ser rejeitado.

## 6. Criar ou evoluir um projeto

1. Crie `projects/<slug>/` como workspace package.
2. Adicione `schema.ts`, `drizzle.config.ts`, `migrations/`, `config.ts`, `screens/` e `src/index.ts`.
3. Gere e revise a migration SQL.
4. Registre schema/config nos registries da API e web.
5. O provisionamento segue: registro no core → `CREATE DATABASE projeto_<id>` → grant → migrations → config inicial. Em falha, compense registro e database.
6. A tela Usuários é sistêmica e injetada automaticamente; não a replique na config comum.
7. Teste isolamento com tokens de dois projetos.

Telas custom são React versionado e referenciadas na config apenas por `componentId`. Crie-as em `projects/<slug>/screens/` exportando `componentId` e `default`; a autodescoberta em build time (via `import.meta.glob`) registra automaticamente. Componentes de tela podem consumir data sources recebidos ou criados pelo api-client; nunca chamam `fetch` diretamente.

## 7. Autenticação e autorização

- Login emite refresh global e lista de projetos.
- Selecionar projeto emite access token curto com `{ sub, projetoId, perfil }`.
- `ProjectScopeGuard` revalida usuário, projeto e pivot a cada request.
- Leitura: todos os perfis. Escrita comum: conforme decorator da rota. Operações globais: admin no projeto `biblioteca-global`.
- Remover usuário globalmente significa desativar e remover vínculos; nunca apagar fisicamente.
- Senha usa argon2id e nunca aparece em resposta ou log.

## 8. API e erros

Controllers validam DTO e chamam services; services contêm regras; repositories contêm SQL. Erros devem usar o formato compartilhado e status coerentes: validação 400, auth 401, autorização 403, ausência 404, conflito 409.

O CRUD genérico aceita somente resources derivados do schema e exclui nomes reservados. Toda escrita passa pelo Zod derivado.

## 9. Testes

- Unitários: regras puras, componentes e guards.
- Funcionais: Nest real + MySQL real.
- Ponta a ponta: login, seleção, CRUD, troca de projeto, logout e persistência.
- Segurança obrigatória: resource fora da whitelist, token ausente, isolamento entre databases, body com `projetoId` e revogação imediata do vínculo.

Teste que cria dados deve limpar seus resíduos mesmo se falhar. Nunca declare conclusão com teste ou build vermelho.

## 10. Containers e CI

O compose sobe MySQL, API e web. A API aplica migrations e seed idempotente antes de iniciar. O nginx do web encaminha `/api` para a API e serve fallback SPA. A CI executa typecheck, lint, migrations/seed em MySQL, testes, builds e builds Docker.

Segredos ficam em `.env` local ou GitHub Secrets. Nunca commitar `.env`, tokens, hashes reutilizáveis ou chaves.

## 11. Versionamento e publicação

A v2 usa o escopo novo `@biblioteca-global/*`; o pacote legado `@alexandretorqueti/biblioteca-global-ui` permanece intacto. SemVer é obrigatório. O workflow de publicação apenas prepara e valida o pacote: publicar no registro e criar tag requer ordem explícita do Alexandre.

## 12. Protocolo para agentes

1. Ler `INFRA.md`, este manual, `POC_DEFINICOES.md`, memória e estado do git.
2. Inspecionar a implementação real; checklist e memória podem estar atrasados.
3. Localizar o padrão mais próximo e preservar API pública.
4. Definir o menor conjunto de arquivos e riscos de compatibilidade.
5. Implementar sem tocar em outros projetos nem em configuração do OpenClaw.
6. Validar testes, build, diff e ambiente proporcionalmente ao risco.
7. Registrar decisões e problemas novos em `memory/` e `MEMORY.md`.
8. Nunca publicar pacote sem autorização explícita.
