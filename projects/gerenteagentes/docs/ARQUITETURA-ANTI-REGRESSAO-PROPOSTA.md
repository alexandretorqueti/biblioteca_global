# Proposta de Arquitetura Anti-Regressão — crescimento devagar e constante

> Autor: programador-senior (monitor cron) · Data: 2026-10-07 · Status: PROPOSTA (decisão pendente do Alexandre)
> Origem: pedido do Alexandre — "sistema construído inteiramente com IA; às vezes cria coisas fora do padrão ou desfaz o que funcionava; quero crescimento devagar e constante, sem regressão, seguindo um padrão específico. Interfaces ajudam mas não bastam."

## 1. Diagnóstico — os 5 modos de falha reais (com evidências desta semana)

### F1. Mudança pela metade (o mais grave e mais frequente)
A IA edita UM lado de um par que existe em DOIS lados:
- **927**: TASK_BLOCKED reroteado para `motor.monitor` (produtor) sem ligar consumidor → 6 dias com fila morta, 34 msgs.
- **949**: consumer declarado com DLX; publisher do mesmo processo declara plain → 406 PRECONDITION_FAILED matou canais nos DOIS motors (green órfão no meio do batch; blue nasceria sem outbox).
- **948**: coluna `purpose` no código; migration criada em pasta errada e sem journal → nunca aplicada → `Unknown column 'mas.purpose'` em produção.
- **0006/0077/0078**: arquivos de migration órfãos do journal → catálogo E42 e prompts ::DONE::/workspace-only nunca ativos (o prompt antigo contribuiu para reincidência de wrong-checkout).

### F2. Falha silenciosa (o sistema prefere continuar a gritar)
- drizzle-kit 0.31 engole erro de migration (spinner + exit 1 sem mensagem) → 20 restarts do blue sem NENHuma linha de erro.
- `catch → retorna vazio` (incidente 912: `/motor-activity` "OK" com SQL quebrado).
- Preflight "concluído" com coluna faltando; bootstrap ignora arquivo órfão sem avisar.
- `EVENT_TASK_IGNORED` sem superfície visível.

### F3. Duas fontes de verdade
- **src vs dist**: green rodava dist velho (default agent-root) vs src novo (.motor-v3-worktrees) → ENOENT no prep de deploy.
- **imagem vs bind-mount**: entrypoint roda do node_modules/repo do host; reboot sem npm ci = API em loop (incidente do login, manhã de 07/10).
- **config.ts vs config.json** (incidente 872), **dois sistemas de migration** (plataforma + runtime do motor) com **mesma tabela de tracking** (`__drizzle_migrations` compartilhada — skip-lógica por created_at interage entre os dois!), **caminho host vs container** (`/home/alexandre/...` vs `/data/workspace/...`), **default duplicado 5× no start.ts**.
- **root vs uid 1000**: motor (container, root) vs script de deploy (host, alexandre) → 2763 arquivos root-owned no .git → deploys falhando desde 06/10.

### F4. Contrato existe mas nada obriga a usar
- `completion_kind` ∈ {code_change, analysis, external_operation, no_code_change} implementado no motor — analista não preencheu (1287 "Validar runtime e migration" tratada como dev → 3 falhas → limbo).
- Prompt DEV com protocolo ::DONE:: e contrato JSON legado mutuamente exclusivos convivendo.

### F5. Conhecimento de ambiente não escrito
- `SET NAMES` é didaticamente correto e QUEBRA no drizzle-kit (prepared statements) — a IA escreve o que é plausível pelo treino, não o que o runner real aceita.
- `log_bin_trust_function_creators=1` para triggers; ACL/chmod do .git; TZ dos logs (UTC no container vs BRT no host).

**Raiz comum**: costuras (seams) entre dois mundos — código↔broker, código↔schema, src↔dist, container↔host, analista↔motor, mudança↔contraparte. TypeScript/interfaces NÃO alcançam essas costuras. Por isso "interfaces não bastam".

## 2. O padrão proposto — "Declarar uma vez, verificar em toda parte, falhar alto"

Três camadas obrigatórias para toda costura:

### Camada 1 — REGISTROS ÚNICOS (single source of declaration)
Nada de defaults duplicados nem pares implícitos. Cada costura ganha UM registro executável:
- `QueueRegistry`: cada fila declarada 1× (nome, args DLX/retry/dlq, TTL, **produtores e consumidores obrigatórios**). Transport DERIVA asserts do registro (fim do 406 por divergência). Boot ASSERTA: toda fila do registro tem consumer ativo; toda fila do broker bate com o registro (census).
- `PathRegistry`: worktree roots, repo paths, mapeamento host↔container — um módulo; start.ts e afins importam (fim dos 5 defaults).
- `MigrationRegistry` (decisão: UNIFICAR os dois sistemas num runner só, ou manter dois com tracking separado + teste de consistência): journal↔arquivos bidirecional validado; toda migration testada em banco scratch ANTES do merge.
- `AgentContractRegistry`: prompts/contratos por papel com versionamento e campo obrigatório validado no parse (completion_kind obrigatório — recusa/infere com warning auditável, nunca NULL silencioso).

### Camada 2 — VERIFICAÇÃO DE INVARIANTES em 4 momentos
A mesma suíte de invariantes estruturais roda em: **(a)** testes unitários, **(b)** boot do motor (falha o boot ou degrada gritando), **(c)** gate pre_deploy, **(d)** smoke pós-deploy:
1. Queue census: filas do broker = registro (args idênticos); consumers ≥ 1 por fila de consumo.
2. Migrations: journal↔arquivos sem órfãos (nos 2 sentidos); sem SET NAMES/DDL incompatível com o runner (lint); tracking íntegro.
3. Schema↔código: colunas referenciadas em SQL do motor existem no banco (grep AST/regex das queries + information_schema — pegaria `mas.purpose` no boot).
4. dist↔src: hash do build confere com o commit (fim do src/dist drift).
5. Prompts ativos: versão ativa de cada chave = versão esperada pelo código.
6. Repositório: sem arquivos root-owned em .git (ou ACL ok); worktrees de integração íntegros.

### Camada 3 — FALHA ALTA (fail loud) + MEMÓRIA DE INCIDENTE
- Proibir `catch → vazio/false` em caminho de decisão: Result<T, Err> ou throw com contexto. Wrapper do drizzle-kit que imprime o erro real.
- **Regra de ouro já dita pelo Alexandre ("não dar o peixe") vira mecanismo**: todo incidente vira (1) tarefa de correção da causa, (2) invariante novo na suíte da Camada 2, (3) teste de reprodução. Exemplos desta semana já teriam virado: census de consumers (927), equivalência produtor/consumer de fila (949), lint de migration (SET NAMES/órfãs), schema-drift (purpose).
- Definition of Done do DEV (contrato): evidência por critério de aceite + invariante/teste novo quando o fix é de incidente. Gate não passa sem isso.

### Processo (crescimento devagar e constante)
- **Fatias verticais pequenas**, uma por vez, com **flag por ponto** (princípio já adotado no plano de governança v3) e paridade antes de melhoria.
- **ADR-lite**: toda decisão estrutural registra 1 arquivo em `docs/` (padrão já existe: INVARIANTE-CONCLUSAO, CONCORRENCIA-E-LOCKS). A IA do futuro lê o ADR antes de mexer — conhecimento de ambiente escrito (F5).
- **Canário de pipeline**: tarefa sintética semanal percorrendo análise→dev→gate→deploy em projeto scratch — detecta costura quebrada ANTES de tarefa real (927 teria aparecido em 1 dia, não 6).
- Deploy: container roda código da IMAGEM pinada por commit (bind-mount só em dev) — decisão de infra do Alexandre.

## 3. Roadmap incremental (cada fase é pequena, testável e executável pelo próprio motor)

- **Fase 1 (semana 1)** — estancar as costuras que sangraram hoje: `QueueRegistry` + derives no transport + census no boot e no pre_deploy; lint de migrations (journal↔arquivos bidirecional + SET NAMES) como teste; `completion_kind` obrigatório no parse do analista (inferência com warning).
- **Fase 2 (semana 2)** — `PathRegistry` (defaults únicos) + verificação schema↔código no boot + smoke pós-deploy automatizado (script único: health, census, DLQs, órfãos, prompts).
- **Fase 3 (semana 3)** — unificação do sistema de migrations (runner único + banco scratch no CI do motor) + hash dist↔src no gate.
- **Fase 4 (semana 4)** — canário de pipeline semanal + ADR-lite obrigatório nas tarefas de arquitetura + regras F1–F5 no contrato do analista/DEV (contexto de anti-padrões).

## 4. O que NÃO fazer
- Não reescrever o motor (o catálogo/primitivas é bom; o problema é disciplina de costura, não paradigma).
- Não confiar só em tipos: nenhuma das falhas desta semana seria pega por interface/type — todas vivem em runtime, broker, banco, filesystem e processo.
- Não criar mecanismo novo sem invariante + teste que o proteja (senão vira mais uma fonte de verdade).
