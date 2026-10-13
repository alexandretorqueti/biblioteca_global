# Auditoria — Subtarefa 1 · Compatibilidade schema/config/telas × banco legado `bdportalemp`

**Tarefa:** Compatibilidade com banco legado (task-p6-1001/1365) · **Projeto:** sistema-adm-global (core id **6241**)
**Data:** 2026-10-13 · **Tipo:** investigation (somente leitura) · **Workspace auditado:** `.motor-v3-worktrees/task-p6-1001/1365/a1`

> **Escopo executado:** SOMENTE LEITURA. Nenhuma alteração de código/schema/config/banco foi executada. Consultas
> usadas: `SELECT`, `SHOW COLUMNS`, `SHOW CREATE TABLE`, `information_schema.*`, HTTP `GET`.
> **Credenciais do legado não copiadas** para arquivos/logs/memória — a senha de `bdportalemp` foi decifrada em
> memória volátil (AES-256-GCM, chave `DB_CREDENTIALS_ENCRYPTION_KEY`) apenas para conectar e consultar (read-only).

---

## 1. Resumo executivo

O `projects/sistema-adm-global/schema.ts` (commit `feb963bc`) **espelha corretamente o legado `bdportalemp`**: as
10 tabelas existem no legado com os mesmos nomes físicos e as mesmas colunas — **zero colunas faltantes/sobrando nas
duas direções**. O bloqueio relatado ("tela não funciona em razão da assinatura do banco legado") vem de **três classes**:

1. **Divergência de estrutura no legado (real, cirúrgica):** `circular.id` e `config_empresa.id` **não têm
   `AUTO_INCREMENT`** no legado, enquanto o schema.ts declara `.autoincrement()` → **INSERT pelo app falha**
   (criar circular / criar empresa). Secundário: `circular.ativo` é `bit(1)` no legado; a coluna `boolean` do drizzle
   faz `value === 1`, e o mysql2 entrega `Buffer` para `bit(1)` → **leitura sempre "falsa"/objeto** no list/detalhe.
   Todo o resto do delta é cosmético (timestamps do legado NOT NULL+DEFAULT CURRENT_TIMESTAMP vs schema anulável+defaultNow).
2. **Divergência de nomes/rota no código do projeto:** Dashboard chama `GET /{slug}/circulares` mas a whitelist usa o
   **nome físico `circular`** (via `coletarTabelas`/`nomeDaTabela`) → **404 por construção**; e a interface local
   `Circular` lê `image_url`/`publicado_em` (snake_case) enquanto `crud.service.listar()` devolve **props TS
   camelCase** do drizzle (evidência de código, §5). A tela **Usuários** usa resource `usuarios`, que o CRUD genérico
   **bloqueia** (`RESOURCES_RESERVADOS`) e o api-client roteia para `/api/usuarios` — **tabela do core, não do legado**.
3. **Pendência de runtime:** API 3003 **fora do ar/reiniciando durante toda a janela de auditoria** (§7) → respostas
   HTTP por rota e log de fingerprint da `ProjectDbFactory` não capturáveis agora. Migration `0004_legado_mirror`
   **nunca aplicada em `projeto_6241`** (prova por hash, §4) — irrelevante enquanto o runtime aponta para o legado,
   mas trava qualquer fallback local (que mantém nomes antigos `circulares`/`contatos_site` e `usuarios` sem `senha`).

---

## 2. (a) Delta por tabela — `schema.ts` × `information_schema` real do `bdportalemp` (MySQL 5.7.32-log)

Método: parser do schema.ts (`mysqlTable("nome")` + nomes físicos de colunas) confrontado coluna a coluna com
`information_schema.COLUMNS` (+`SHOW CREATE TABLE`, `KEY_COLUMN_USAGE`, `REFERENTIAL_CONSTRAINTS`) do legado.
Saídas brutas anexadas em `/tmp/delta_legado.txt` (reprodutível via `scripts-leitura/comparar_legado.cjs`).

**Globais:** 10×10 tabelas presentes; contagem de colunas idêntica (usuarios 9, clientes 21, responsaveis 16,
contratos 10, api_contatosite_contatos 11, circular 7, departamentos 4, cargos 4, colaboradores 23, config_empresa 6).
Sem tabela/coluna órfã em nenhum sentido. Dados: clientes 7, circular 3 (ids 1,2,3), api_contatosite_contatos 10
(9 com `assunto=''`), departamentos 5, usuarios 6, config_empresa 1, responsaveis 0, contratos 0, cargos 0, colaboradores 0.

| Tabela | Colunas s×l | Delta DDL pendente no legado | Severidade p/ telas |
|---|---|---|---|
| usuarios | 9×9 | `created_at/updated_at` legado NOT NULL def CURRENT_TIMESTAMP vs schema anulável defNow (cosmético). Legado tem `UNIQUE(email)` que o schema não declara. | Nenhuma (SELECT/UPDATE ok) |
| clientes | 21×21 | **zero** | nenhuma |
| responsaveis | 16×16 | **zero** de colunas; FK legado `responsaveis_ibfk_1` (cliente_id→clientes.id, ON DELETE CASCADE) não declarada no schema.ts | nenhuma p/ CRUD (childRoutes filtram por cliente_id) |
| contratos | 10×10 | `ativo` legado NOT NULL def 1 vs schema anulável (cosmético); FK legado `contratos_ibfk_1` (idem) | nenhuma |
| api_contatosite_contatos | 11×11 | **zero**. Legado exige `site_id` NOT NULL e FK `→ api_contatosite_sites.id` (tabela fora do schema.ts do projeto; 1 linha no legado). Tela é de **leitura** (sem INSERT pelo app) | nenhuma p/ listagem |
| circular | 7×7 | **(1) `id` sem `AUTO_INCREMENT`** (schema declara autoincrement; legado só PRIMARY KEY) → **INSERT do app quebra**. (2) `ativo` é `bit(1)` def b'1' vs boolean drizzle → **leitura errada** (Buffer). | **BLOQUEANTE p/ RH/Circulares (criar) e Dashboard (exibir filtro de ativo)** |
| departamentos | 4×4 | timestamps (cosmético); `nome` NOT NULL + UNIQUE | nenhuma |
| cargos | 4×4 | idem departamentos | nenhuma |
| colaboradores | 23×23 | `ativo`/`created_at`/`updated_at` nulabilidade (cosmético); sem FK no legado para cargo_id/departamento_id (schema também não declara; múltipleChoice só referencia por id) | nenhuma |
| config_empresa | 6×6 | **(1) `id` sem `AUTO_INCREMENT`** → INSERT quebra (tela é singleton/UPDATE — ver §5.6). | **Risco p/ criar empresa; UPDATE ok** |

**Delta de DDL pendente exato (mínimo) para o legado alinhar 100% ao schema.ts:**
```sql
ALTER TABLE circular        MODIFY id INT(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE config_empresa  MODIFY id INT(11) NOT NULL AUTO_INCREMENT;
-- (opcional, cosmético) circular.ativo bit(1) -> tinyint(1) para o boolean do drizzle;
-- ou ajustar o schema.ts para espelhar bit(1). Decisão pertence à subtarefa 2 (code_change) / 3 (external DDL).
```
Nada mais é obrigatório: nomes, colunas e tipos (com `SHOW CREATE`) já batem. Observações não-bloqueantes:
latin1_general_ci no legado vs collation default nos timestamps; `usuarios.email` UNIQUE não refletido no schema.

**Nota sobre `0004_legado_mirror.sql`:** ela **descreve o caminho `projeto_6241` → espelho do legado** (RENAMES
`circulares`→`circular`, `contatos_site`→`api_contatosite_contatos`, adds/removes) — **não** é DDL para rodar no
legado. Rodar 0004 contra o legado seria destrutivo (RENAME de tabelas já nos nomes novos + DROP de colunas existentes).
A 0004 também contém contradições internas com o schema.ts atual: dropa `usuarios.created_at/updated_at`, mas o
schema.ts os declara (e o legado os tem) → o delta da tabela 1 acima decorre disso.

---

## 3. (b) Status real da migration `0004_legado_mirror`

| Database | `__drizzle_migrations` | Tabelas físicas | Veredito |
|---|---|---|---|
| `projeto_6241` (local 3308) | ids aplicados com hash==SHA256 dos arquivos: 0000 (`645434…`), 0001 (`ff91af…`)*, 0002 (`3f3dab…`), 0003 (`138a6e…`). **Hash da 0004 (`b3a63b55…`) AUSENTE.** *(o índice `id` da tabela local é sequencial e não representa idx do journal — o que vale é o hash)* | `circulares`, `contatos_site` (nomes **ANTIGOS**), `usuarios` **sem** `senha`/`primeiro_acesso` | **NUNCA aplicada** — 100% consistente: journal da 0004 existe (idx 4), registro ausente, estrutura pré-0004 intacta |
| `bdportalemp` (legado nuvem) | **sem tabela `__drizzle_migrations`** | já nos nomes NOVOS com todas as colunas da 0004 (senha, primeiro_acesso, numerocontrato, autor, ativo, site_id, ip…) | 0004 **não corre e não precisa correr** no legado — o legado já está **no estado-alvo da 0004** (conferente com a memória 2026-09-25: ALTERs manuais aplicados ao legado) |

Conclusão: para o runtime atual (projeto 6241 **credenciado com conexão custom → legado**), a 0004 está
**superada**; mas enquanto `projeto_6241` não recebê-la, **qualquer fallback env→`projeto_<id>` quebra** (schema.ts
espera nomes novos). Não houve aplicação de migration nesta subtarefa (proibido — e desnecessária ao escopo).

---

## 4. (c) Credenciação do projeto 6241 + resolução runtime da `ProjectDbFactory`

**Credenciação no core — COMPLETA (verificada, sem expor a senha):**
`core.projetos WHERE id=6241`: `db_host=bdportalemp.mysql.dbaas.com.br`, `db_port=3306`,
`db_database=bdportalemp`, `db_user=bdportalemp`, `db_password_criptografado` presente (62 chars, formato AES-GCM
`iv:tag:ciphertext` base64) e **descriptografável** com `DB_CREDENTIALS_ENCRYPTION_KEY` do `.env` — a conexão
remota de leitura que produziu §2 usou exatamente esse caminho (prova de integridade da credencial).

**Código da fábrica (`apps/api/src/modules/crud/project-db.factory.ts`):** cache por `projetoId` com invalidação por
*fingerprint* `h(host:porta:database:user:senhaHash:timestampDeConfig)`; quando a config custom está completa usa as
credenciais do core (senão fallback env + `projeto_<id>`). Com a credenciação acima completa, **em código a fábrica
resolve para o legado**. O provisionamento automático (`garantirDatabaseProvisionado`/`provisioner`) **não roda**
para projeto com conexão custom — corrobora §3 (por isso `projeto_6241` nunca recebeu a 0004).

**Runtime — NÃO VALIDADO nesta janela:** a API 3003 estava fora do ar (ver §7); o log de fingerprint/cache não pôde
ser capturado ao vivo. **Evidência indireta positiva:** às ~14:0x–15:5x a porta 3003 respondeu com stack NestJS vivo
(`404 Cannot GET /api/health` = rota inexistente, mas processo atendendo) e rotas `/api/crud/...` retornaram **401**
(guards ativos). Estado final = processo em ciclo de restart/parado. Pendência declarada para a subtarefa 4
(validação runtime), com pré-requisito explícito: **subir/reiniciar a API com o código do worktree** para forçar
nova resolução da fábrica (fingerprint da config 6241).

---

## 5. (d) Mapa de chamadas de dados por tela (config.ts ≡ config.json, 957 linhas; resources whitelist = nomes físicos)

Whitelist efetiva (`DynamicSchemaRegistry` carrega `projects/sistema-adm-global/schema.ts`; `coletarTabelas` usa o
nome físico): `usuarios, clientes, responsaveis, contratos, api_contatosite_contatos, circular, departamentos,
cargos, colaboradores, config_empresa`. Rota do controller: `GET /api/:slug/:resource` (JwtAuthGuard+ProjectScopeGuard);
`RESOURCES_RESERVADOS` bloqueia no CRUD genérico: `auth, usuarios, projetos, projetos_usuarios, refresh_tokens`.

| Tela | Resource no config | Caminho efetivo | Veredicto vs legado |
|---|---|---|---|
| **Início (Dashboard, custom)** | — (fetch manual) | `GET /{slug}/circulares` | **404 garantido**: resource correto é `circular`. E interface snake_case (`image_url`, `publicado_em`) vs saída camelCase (§5.11). **Duplo bug de código.** |
| Hub Administrativo / Hub RH / Hub Admin (custom) | — | **0 chamadas de dados** (grep `useApi|http.request|fetch(` = 0 nos 3 arquivos); só navegação | ok |
| Clientes (cadastro) | `clientes` | `/clientes` | **compatível** (delta zero §2) |
| └ child Responsáveis | `responsaveis` (filter `clienteId`→coluna `cliente_id` aceita pelo `colunaDaTabela`? — **NÃO**: `getTableColumns` indexa por PROPriedade TS; `clienteId` é a prop, ok) | `/responsaveis?clienteId=` | compatível |
| └ child Contratos | `contratos` (filter `clienteId`) | `/contratos?clienteId=` | compatível (`numerocontrato`/`linkcontrato` nos nomes novos) |
| Contatos do Site | `api_contatosite_contatos` | `/api_contatosite_contatos` | **compatível** leitura; INSERT exigiria `site_id` (não há campo no form; tela é read-only por design) |
| Circulares (RH) | `circular` | `/circular` | list/UPDATE ok; **INSERT quebra no legado (sem AUTO_INCREMENT) e `ativo` bit(1) deforma a grade** |
| Colaboradores | `colaboradores` + multipleChoice `cargos`/`departamentos` | `/colaboradores`, `/cargos`, `/departamentos` | compatível |
| **Usuários (Config Admin)** | `usuarios` | api-client: `RESOURCES_COM_ENDPOINT_DEDICADO` → **`/api/usuarios` (core!)** | **tela lê a tabela `core.usuarios`, NÃO `bdportalemp.usuarios`**. Além disso `hiddenColumns` usa `createdAt/updatedAt` e faltam labels p/ `primeiro_acesso` — mas moot enquanto o resource dedicado for escolhido. **Decisão de produto pendente (subtarefa 2):** usar resource livre p/ tabela do legado OU manter core. |
| Empresa (singleton) | `config_empresa` | `/config_empresa` | list/UPDATE ok; INSERT quebra (sem AUTO_INCREMENT) — mas registro único já existe (1 linha) |
| Departamentos | `departamentos` | `/departamentos` | compatível |
| Cargos | `cargos` | `/cargos` | compatível |

### 5.11 Casing (critério explícito)
- **Entrada (form→API):** `normalizarChaves` converte camelCase→snake e `paraChavesDoDrizzle` snake→prop TS: **ok**.
- **Saída (API→tela):** `listar()/detalhar()` retornam `items as Record<string,unknown>` **direto das linhas drizzle**
  = props TS **camelCase** (`publicadoEm`, `imageUrl`, `siteId`, `dataEnvio`, `createdAt`). **Nenhuma serialização
  snake_case na saída** (evidência de código crud.service.ts §listar/detalhar; sem middleware de transformação).
- Consequência por tela: Dashboard (snake_case manual) **quebra**; telas cadastro **já esperam camelCase** (o próprio
  config usa props camel em `hiddenColumns`/`columnLabels`: `dataEnvio`, `imageUrl`, `publicadoEm`, `siteId`,
  `userAgent`, `createdAt`...) → **consistentes**. `usuarios` no config usa `primeiro_acesso`/`senha` (nomes de coluna)
  no hiddenColumns — funciona só por coincidência de prop==coluna nessas linhas (`primeiro_acesso` é a própria prop;
  `senha` idem). Verificado no schema.ts: props declaradas `primeiro_acesso`, `senha` — ok.

---

## 6. (e) Causa-raiz por tela (classificação do bloqueio)

**Classe 1 — divergência de estrutura no legado:**
- `circular.id` / `config_empresa.id` sem AUTO_INCREMENT → **criar circular falha; criar empresa falha**.
- `circular.ativo` bit(1) → switch/coluna "Ativo" da tela de Circulares exibe valor errado (Buffer≠1→false) em LIST/DETALHE.
- (demais tabelas: delta zero ou cosmético — não explicam bloqueio).

**Classe 2 — divergência de nomes/rota no código do projeto:**
- Dashboard: `/{slug}/circulares` ≠ whitelist `circular` → **tela "Início" sem circulares (erro/404) mesmo com tudo mais ok**.
- Dashboard: interface snake_case vs payload camelCase → mesmo corrigindo a rota, os cards sairiam com data/imagem vazias.
- Usuários: resource reservado → tela aponta para o core em vez do legado (nome/rota no código/plataforma, não no legado).

**Classe 3 — pendências de runtime (API não reiniciada):**
- API 3003 fora do ar durante toda a auditoria (§7); enquanto o processo ativo não carregar o código atual +
  credenciais 6241, **nenhuma tela funciona** independentemente das classes 1/2.
- `projeto_6241` sem 0004: se a config custom for removida/indisponível, o fallback local quebra (schema novo × banco antigo).

---

## 7. Evidência de runtime (janela de auditoria)

- `14:0x`: `host.docker.internal:3003` respondia NestJS vivo (`404 Cannot GET /api/health`; `/api/crud/sistema-adm-global/...` → `401 Unauthorized`).
- `15:0x–18:16`: **ECONNREFUSED** em todas as 12 rotas-alvo, inclusive `GET /api/` raiz (código 000). Loop de
  observação contínuo ~10 min + ~12 sondagens → API **não subiu** durante a janela.
- Rotas-alvo montadas com JWT admin assinado (usuário 5162, perfil admin, vínculo `projetos_usuarios` 6241 —
  verificação por query `SELECT` somente leitura; token com exp 2 min; senha do token não registrada aqui):
  `/sistema-adm-global/circulares`, `/circular`, `/clientes`, `/api_contatosite_contatos`, `/responsaveis`,
  `/contratos`, `/departamentos`, `/cargos`, `/colaboradores`, `/config_empresa`, `/sistema-adm-global/usuarios`,
  `/usuarios`. Status por rota **não capturado** (processo down) → registrado como pendência de runtime (§6.3),
  não como falha de rota. A expectativa por análise de código: `circulares`→404, `circular`→200, dedicados→200(core).
- Sem processo NestJS do projeto dentro deste container (sem `dist/`, sem listener local); a API 3003 roda no host
  e não pode ser (re)iniciada por esta subtarefa (proibição de runtime/deploy + escopo somente-leitura).

---

## 8. Reprodutibilidade (scripts somente-leitura, fora do worktree versionado)

- `comparar_legado.cjs` — diff schema.ts × information_schema do legado (delta por tabela + FKs).
- `delta_inverso.cjs` — mesma matriz na direção contrária (schema NOT NULL × legado anulável; detecção de auto_increment).
- `evidencia_rotas.cjs` — GETs autenticados nas 12 rotas com redação de `senha` nas respostas (não loga token).
Saídas: `/tmp/delta_legado.txt` (integral). Nenhum script escreve nos bancos (somente SELECT/SHOW/information_schema
e HTTP GET). Credenciais: lidas do core/.env em memória; nada impresso.

## 9. Encaminhamentos para as próximas subtarefas (sem executar — fora do escopo daqui)

1. **(Subtarefa 2, code_change)** Dashboard: rota `circulares`→`circular` + interface camelCase
   (`imageUrl`, `publicadoEm`) **ou** padronizar serialização snake_case na API (escolher UMA convenção; hoje a
   plataforma devolve camel). Usuários: decidir resource (`usuarios` reservado → core) vs nova prop de config.
2. **(Subtarefa 3, external DDL com backup)** no legado: `ALTER ... AUTO_INCREMENT` em `circular.id`/`config_empresa.id`
   (+ opcional `bit(1)→tinyint(1)`). NÃO rodar a 0004 no legado (§2, é destrutiva lá). Se `projeto_6241` continuar em
   uso como fallback, aplicar a 0004 **somente** nele.
3. **(Subtarefa 4, runtime)** API no ar com código atual; conferir log de fingerprint da ProjectDbFactory (cache por
   6241 → legado), replay das 12 rotas com massa de dados real do legado, e smoke das 10 telas.
