# Auditoria de compatibilidade com `bdportalemp`

Data da consulta: 2026-10-13. Escopo: somente leitura; nenhum código, banco,
migration, serviço ou credencial foi alterado. Senhas e valores criptografados
foram deliberadamente omitidos deste relatório.

## Resultado executivo

- O core registra o projeto 6241 com os cinco campos de conexão customizada
  preenchidos. A consulta direta ao database configurado confirmou que o alvo
  é o legado `bdportalemp` e que as dez tabelas do `schema.ts` existem.
- O runtime deste workspace não estava ativo (API em `localhost:3003` recusou
  conexão); portanto não há log de `ProjectDbFactory` que prove a conexão em
  cache. Pela implementação, uma instância reiniciada resolve a configuração
  customizada quando os cinco campos estão preenchidos; sem reinício, o estado
  corrente não pode ser confirmado.
- `0004_legado_mirror` não está aplicada em `bdportalemp`: o legado não possui
  `__drizzle_migrations`. No database local `projeto_6241`, a migration também
  não está aplicada: há `0000`–`0003` e permanecem `circulares`/`contatos_site`.
  A migration registrada no journal do repositório é apenas intenção local.
- O legado já contém os nomes físicos esperados pelo schema final. O delta
  estrutural residual é principalmente tipo de ID, `timestamp` versus
  `datetime`, `char` versus `varchar`, atributos `AUTO_INCREMENT`/`ON UPDATE`
  e índices/FKs extras.
- O bloqueio inequívoco do Dashboard é de rota e casing: ele chama
  `/{slug}/circulares`, mas `circular` é o único resource whitelistado; além
  disso, a interface espera `image_url`/`publicado_em` enquanto Drizzle devolve
  `imageUrl`/`publicadoEm`.

## Evidência do banco e migration

Consulta somente leitura ao core: o registro `id=6241`, `slug=sistema-adm-global`
tem `dbHost`, `dbPort`, `dbDatabase`, `dbUser` e senha criptografada presentes.
No alvo customizado, `information_schema.TABLES` retornou as dez tabelas:

`api_contatosite_contatos`, `cargos`, `circular`, `clientes`, `colaboradores`,
`config_empresa`, `contratos`, `departamentos`, `responsaveis`, `usuarios`.

No `projeto_6241` local, `__drizzle_migrations` contém quatro registros, com
hashes correspondentes às migrations 0000, 0001, 0002 e 0003. Não há registro
0004; as tabelas antigas ainda são `circulares` e `contatos_site`.
No `bdportalemp`, `__drizzle_migrations` não existe. Logo, 0004 está **não
aplicada em ambos**; não é correto aplicá-la ao legado, pois ela tenta renomear
as tabelas que já estão renomeadas.

Fontes: `projects/sistema-adm-global/migrations/meta/_journal.json:4-39`,
`projects/sistema-adm-global/migrations/0004_legado_mirror.sql:1-7` e consulta
ao `information_schema` dos dois databases.

## Delta tabela a tabela

Comparação entre `schema.ts` (nome físico de `mysqlTable`, tipo Drizzle,
nulabilidade, default e auto incremento) e o `information_schema` real do
legado. “Extra no legado” é uma diferença real, ainda que normalmente
compatível com leitura.

| Tabela | Colunas faltantes/extras e renomes | Divergências de tipo/atributo | Chaves/índices |
|---|---|---|---|
| `usuarios` | Nenhuma coluna faltante; nomes e ordem lógica batem. | `id`: schema `BIGINT UNSIGNED AUTO_INCREMENT`, legado `INT(11)` sem auto incremento. `created_at`/`updated_at`: schema `TIMESTAMP` nullable/default current, legado `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` e `updated_at ON UPDATE`. | Legado tem `UNIQUE(email)`; schema não declara unique. |
| `clientes` | Nenhuma. | `id`: `BIGINT UNSIGNED AUTO_INCREMENT` no schema versus `INT(11) AUTO_INCREMENT` no legado. `uf`: schema `VARCHAR(2)`, legado `CHAR(2)`. `data`/`data_edicao`: schema `TIMESTAMP`, legado `DATETIME`; legado adiciona `ON UPDATE` em `data_edicao`. | Nenhuma FK no legado; schema também não declara FK. |
| `responsaveis` | Nenhuma. | `id` e `cliente_id`: schema `BIGINT UNSIGNED` (id auto), legado `INT(11)` (id auto). `uf`: `VARCHAR(2)` versus `CHAR(2)`. `data`: `TIMESTAMP` versus `DATETIME`. | Legado tem `responsaveis_ibfk_1(cliente_id→clientes.id) ON DELETE CASCADE`; schema não declara FK. |
| `contratos` | Nenhuma; `numero→numerocontrato` já está renomeado no legado. | `id` e `cliente_id`: `BIGINT UNSIGNED` versus `INT(11)` (id auto). `data`: `TIMESTAMP` versus `DATETIME`. | Legado tem `contratos_ibfk_1(cliente_id→clientes.id) ON DELETE CASCADE`; schema não declara FK. |
| `api_contatosite_contatos` | Nenhuma. | `id` e `site_id`: schema `BIGINT UNSIGNED` (id auto) versus legado `INT(11)` (id auto). `data_envio`: `TIMESTAMP` versus `DATETIME`. | Legado tem FK `site_id→api_contatosite_sites.id` com `RESTRICT/RESTRICT`; schema não declara FK. |
| `circular` | Nenhuma; tabela física correta. | `id`: schema `BIGINT UNSIGNED AUTO_INCREMENT`, legado `INT(11)` **sem** auto incremento. `publicado_em`: `TIMESTAMP` versus `DATETIME`. `ativo`: Drizzle boolean (tinyint esperado) versus legado `BIT(1)`. | Nenhuma. |
| `departamentos` | Nenhuma. | `id`: schema `BIGINT UNSIGNED AUTO_INCREMENT`, legado `INT(11) AUTO_INCREMENT`. `created_at`/`updated_at`: `TIMESTAMP` nullable versus `DATETIME NOT NULL`, com `ON UPDATE` no legado. | Legado tem `UNIQUE(nome)`; schema não declara unique. |
| `cargos` | Nenhuma. | `id`: schema `BIGINT UNSIGNED AUTO_INCREMENT`, legado `INT(11) AUTO_INCREMENT`. `created_at`/`updated_at`: `TIMESTAMP` nullable versus `DATETIME NOT NULL`, com `ON UPDATE` no legado. | Nenhum índice extra observado. |
| `colaboradores` | Nenhuma. | `id`, `cargo_id`, `departamento_id`: schema `BIGINT UNSIGNED`, legado `INT(11)`; id é auto no schema e legado. `created_at`/`updated_at`: `TIMESTAMP` nullable versus `DATETIME NOT NULL`, com `ON UPDATE` no legado. Os demais tipos, enum e nulabilidade batem. | Legado tem `UNIQUE(cpf)` e índices não únicos em `cargo_id`/`departamento_id`; schema não declara índices/FKs. Não há FK real para cargos/departamentos. |
| `config_empresa` | Nenhuma. | `id`: schema `BIGINT UNSIGNED AUTO_INCREMENT`, legado `INT(11)` **sem** auto incremento. Demais cinco colunas batem. | Nenhuma. |

Observação: as diferenças de `INT`/`BIGINT` não impedem listagem por si só,
mas tornam o espelho não exato e podem causar incompatibilidade em inserts ou
geração de DDL. As FKs reais não foram declaradas no schema; portanto não são
“faltantes” no schema esperado, mas são invariantes do legado que a aplicação
deve preservar.

### DDL residual (não executado)

Abaixo está o delta DDL para transformar o legado no tipo/atributos declarados
em `schema.ts`; ele é uma especificação de pendência, não um script de
aplicação. As remoções de índices/FKs só seriam corretas se a decisão fosse
fazer o banco coincidir literalmente com o schema; para operar no legado, as
FKs devem ser mantidas e apenas documentadas como extras.

```sql
-- IDs: todos os ids do schema são BIGINT UNSIGNED AUTO_INCREMENT.
ALTER TABLE usuarios MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE clientes MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE responsaveis MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  MODIFY cliente_id BIGINT UNSIGNED;
ALTER TABLE contratos MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  MODIFY cliente_id BIGINT UNSIGNED;
ALTER TABLE api_contatosite_contatos
  MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  MODIFY site_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE circular MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE departamentos MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE cargos MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE colaboradores
  MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  MODIFY cargo_id BIGINT UNSIGNED NOT NULL,
  MODIFY departamento_id BIGINT UNSIGNED;
ALTER TABLE config_empresa MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

-- Datas: o schema usa TIMESTAMP nullable, default current_timestamp,
-- sem ON UPDATE.
ALTER TABLE usuarios
  MODIFY created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE clientes
  MODIFY uf VARCHAR(2), MODIFY data TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY data_edicao TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE responsaveis MODIFY uf VARCHAR(2),
  MODIFY data TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE contratos MODIFY data TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE api_contatosite_contatos
  MODIFY data_envio TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE circular
  MODIFY publicado_em TIMESTAMP NULL, MODIFY ativo TINYINT(1) NULL DEFAULT 1;
ALTER TABLE departamentos
  MODIFY created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cargos
  MODIFY created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE colaboradores
  MODIFY created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;
```

Diferenças de constraints observadas, sem DDL recomendado para o modo legado:
`usuarios.email` (UNIQUE `email`), `departamentos.nome` (UNIQUE `nome`),
`colaboradores.cpf` (UNIQUE `cpf_unique`), índices `cargo_id`,
`departamento_id`, `site_id`, `cliente_id` e as FKs
`responsaveis_ibfk_1`, `contratos_ibfk_1` e `api_contatosite_contatos_ibfk_1`.
O schema atual não declara nenhuma delas; removê-las reduziria a integridade
do legado e não é necessário para o CRUD funcionar.

## Rotas, whitelist e telas

`coletarTabelas` indexa a whitelist pelo nome físico de `mysqlTable`, não pelo
nome da variável exportada (`packages/schema-tools/src/gerar-config.ts:19-48`).
Assim, `circulares` exportada em `schema.ts` gera a chave/resource `circular`.
O controller atende `GET /api/:slug/:resource` e o service chama
`resolverTabela`, que rejeita resource fora do registry
(`apps/api/src/modules/crud/crud.controller.ts:55-103`;
`apps/api/src/modules/crud/crud.service.ts:391-402`).

O Dashboard chama `GET /api/sistema-adm-global/circulares` (a base `/api` vem
do cliente HTTP), em `screens/sistema-adm-global-dashboard.tsx:68-78`.
Conclusão: a rota retorna 404 “Resource não encontrado” antes de consultar o
legado; a rota compatível seria o resource físico `circular`.

O retorno de `CrudService.listar` é `items` diretamente do select Drizzle
(`apps/api/src/modules/crud/crud.service.ts:447-459`). Para as propriedades
camelCase do schema, ele entrega `imageUrl` e `publicadoEm`, enquanto a
interface `Circular` e o render do Dashboard declaram/acessam `image_url` e
`publicado_em` (`screens/sistema-adm-global-dashboard.tsx:33-40` e uso no
modal). O dado chega, mas imagem/data ficam vazios ou incorretos por casing.

As dez telas `cadastro` declaradas em `config.ts`/`config.json` e seus resources
são:

| Tela/rota | Resource físico | Estado da rota/config |
|---|---|---|
| Clientes `/clientes` | `clientes` | compatível |
| Child Responsáveis | `responsaveis` filtrado por `clienteId` | compatível com FK legado |
| Child Contratos | `contratos` filtrado por `clienteId` | compatível com FK legado |
| Contatos `/contato` | `api_contatosite_contatos` | compatível; `siteId` é obrigatório |
| Colaboradores `/colaboradores` | `colaboradores` | resource/tipos principais compatíveis |
| Circulares `/circular` | `circular` | compatível; Dashboard usa nome errado |
| Usuários `/usuarios` | `usuarios` | compatível, mas legado tem unique email |
| Empresa `/config-empresa` | `config_empresa` | compatível; singleton não é imposto pelo schema |
| Departamentos `/departamento` | `departamentos` | compatível, legado tem unique nome |
| Cargos `/cargo` | `cargos` | compatível |

Os três hubs (`hub-administrativo`, `hub-rh`, `hub-admin`) são somente
navegação e não fazem consulta de dados. Os `hiddenColumns` e labels usam uma
mistura intencional de propriedades físicas Drizzle e propriedades camelCase:
`createdAt`/`updatedAt`, `siteId`, `userAgent`, `dataEnvio`, `imageUrl` e
`publicadoEm` estão coerentes com o schema; `primeiro_acesso` e `data_edicao`
estão snake_case porque foram declarados assim no schema. Não há evidência de
erro de casing nesses overrides equivalente ao erro confirmado no Dashboard.

## Runtime e causa-raiz

`ProjectDbFactory` busca os cinco campos customizados no core, calcula cache
por fingerprint incluindo host/porta/database/usuário/senha criptografada e
reconecta quando o fingerprint muda (`apps/api/src/modules/crud/project-db.factory.ts:93-110`;
`128-200`). A consulta ao core confirmou configuração completa e a conexão
somente leitura ao alvo confirmou o legado. Contudo, a API não estava escutando
em `localhost:3003`, então não foi possível obter log de fingerprint/cache ou
provar a instância atualmente carregada. Classificação: **pendência de
runtime — reiniciar/revalidar a API no ambiente real e coletar log sem segredo**.

Causa-raiz classificada por evidência:

1. **Divergência de nomes/rota no código:** Dashboard usa `circulares` em vez
   de `circular`; é bloqueio determinístico pela whitelist.
2. **Divergência de nomes/casing no código:** Dashboard lê snake_case de um
   retorno Drizzle camelCase; afeta imagem e data mesmo após corrigir a rota.
3. **Divergência estrutural residual:** schema não é um espelho byte a byte do
   legado (IDs, datas, `uf`, auto incremento, defaults, unique/FKs). As tabelas
   e colunas existem, portanto isso não explica sozinho um 404 de resource.
4. **Pendência de runtime:** ausência de API ativa/log impede confirmar que o
   processo que atende telas já carregou a credenciação do legado.

Nenhuma alteração de código ou banco foi executada nesta auditoria.

## Validação da tentativa anterior

O `npm run test` informado falhou em
`projects/gerenteagentes/screens/__tests__/OperationMapScreen.selection.test.tsx`
por `marker.animate is not a function` em `OperationMapCanvas.tsx`, além de
avisos de `act(...)` em vários testes. Esse erro pertence ao projeto
`gerenteagentes`, fora do escopo autorizado, e não invalida as evidências
estáticas nem as consultas somente leitura desta auditoria. Nenhuma correção
foi aplicada nele ou em qualquer outro código; corrigir esse teste exigiria
ampliar o escopo da subtarefa.
