# MODO_DESIGNER_GIT_CONFIG.md — Config de telas como dado versionado + Modo Designer

> **Status:** aprovado em conversa (13/10/2026) como desenho; **aguardando autorização do Alexandre para iniciar implementação.** Nenhum código foi escrito.
> **Autores da decisão:** Alexandre + Bibliotecária Global 📚.
> **Este documento supersede** a proposta anterior de "save duplo banco+git" e o polling periódico. Registra também as alternativas descartadas, para que não ressuscitem.
> Relacionado: `docs/MANUAL_CONFIG_PROJETOS.md`, `POC_DEFINICOES.md` §6.2/§7, `ETAPAS_DESENVOLVIMENTO.md`.

---

## 1. Problema e origem

Objetivo do Alexandre: **modo designer** no GeradorSistema, disponível **apenas para o usuário mestre**, permitindo, na listagem e na inclusão/edição:

1. Clicar na label de um campo e editá-la;
2. Ocultar um campo **da visualização** (nunca da tabela/banco);
3. Adicionar à tela campos que existem no schema mas ainda não aparecem na grid/form;
4. Editar propriedades de apresentação do campo (largura, ordem, tipo etc.).

**Limite inegociável:** nunca alterar o NOME do campo — nome é `schema.ts` (DDL), fora do alcance de qualquer ferramenta de apresentação.

Diagnóstico do estado atual (verificado no código em 13/10/2026):

- `CadastroOverridesConfig` (`packages/shared/src/config.ts`) já expressa quase tudo como dado: `hiddenColumns`, `columnLabels`, `fields` com flags `gridVisible/editable/insertable`. Faltam apenas `width`/ordem de coluna (extensões opcionais, backward-compatible) e a **UI** que edita isso.
- Runtime lê a config de `core.projetos.config` (banco). O `projects/<slug>/config.ts` é fonte de **provisão**, não de runtime.
- **Armadilha identificada:** `database/seed.ts` (~linha 188) é upsert — `set: { nome, ativo, config }` — e reexecução do seed **sobrescreve silenciosamente** qualquer config editada no banco. Qualquer designer que salvasse no banco viveria sob risco de apagamento.

## 2. Decisão arquitetural central

> **A config de telas deixa de viver no banco e passa a viver em um repositório git próprio. O commit É o deploy da config.**

```
biblioteca-global (repo de código)        biblioteca-configs (repo de DADOS de tela)
  schema.ts → migrations/DDL                projects/<slug>.json  ← fonte única de config
  motor desenvolve aqui                     designer e motor escrevem aqui
  config.ts → wrapper/migração              API lê de um working copy local (bind mount)
```

Princípios derivados (todos acordados na conversa de 13/10):

| # | Princípio | Consequência |
|---|---|---|
| P1 | Config é dado, não código | Repo git separado; JSON por projeto; código e telas evoluem em ritmos independentes |
| P2 | Quem escreve, comita e empurra no instante do evento | Não existe "JSON alterado aguardando deploy"; `reset --hard` do sync é seguro: **se não está no git, não existe** |
| P3 | A API lê do working copy local, nunca do GitHub no caminho quente | Leitura de disco (µs, offline); GitHub = transporte + histórico, não servidor de runtime |
| P4 | Quem muda, avisa — nenhum timer/polling | Refresh por sinal (evento), não por relógio; reconciliação periódica implícita no boot do blue-green |
| P5 | Editor humano nunca é sobrescrito às cegas | Push condicional por sha-base; delta do motor aplicado por `montarConfigInicial` (rebase estruturado); colisão real → gate falha e avisa |
| P6 | Gate server-side | Salvar config é mutação para todos os usuários do projeto; autorização pelo token (`{ sub, projetoId, perfil }`), nunca só botão escondido no front |
| P7 | Auditoria e reversibilidade de graça | Blame do repo = log de quem mudou qual tela; rollback = `git revert`/checkout de sha; `deploy_requests` passa a guardar `code_sha` + `config_sha` |
| P8 | Documentação viva sobrevive | Narrativa de domínio sai de comentário em .ts: `_docs` no topo do JSON ou `<slug>.md` irmão no repo de configs; intenção por tela migra para `description` da tela (dado, sobrevive round-trip) |

## 3. Fluxo operacional final (os três escritores)

| Escritor | Evento | O que acontece automaticamente |
|---|---|---|
| **Designer (Alexandre)** | salvar tela | validação (Zod + `validarConfigContraSchema`) → commit + push → working copy da API atualizado **na mesma operação** → cache em memória invalidado. Latência percebida: zero |
| **Motor** | início de task | puxa `projects/<slug>.json` do repo de configs @ sha X e registra X na task |
| **Motor** | deploy | push do código **+** push do delta do JSON (via `montarConfigInicial` com sha-base) → `POST /api/config/refresh` (token interno, rede local) → API faz `fetch + reset --hard` + recarrega. Refresh não confirmar → deploy marcado como falho |
| **Humano (fuga de emergência)** | commit manual no GitHub | botão "Sincronizar config" na admin UI dispara o mesmo `refresh` |

Boot da API: valida o working copy (volume do host, sobrevive à recriação do container); vazio/corrompido → **auto-cura** com clone do zero (loga alto); são → `fetch + reset` para o último sha. Cada deploy recria o container → reconciliação embutida no ritmo de deploys, sem cron.

## 4. Alternativas descartadas (registradas para não ressuscitar)

- **Save duplo banco+git com export manual** (proposta inicial): mantinha duas fontes competindo; o export "puxar pro código" era fardo do humano. Substituída pelo repo de dados.
- **Designer salvando só no banco**: armadilha — o seed upsert apagaria as mudanças. Descartada junto com o banco como fonte de config.
- **`config.ts` regido pelo robô**: serialização de TS por máquina destrói comentários de domínio e diffs legíveis. O robô só escreve JSON.
- **Polling a cada minuto**: rejeitado pelo Alexandre; todo escritor é ator controlado pelo sistema → sinal por push, não descoberta por relógio.
- **GitHub webhook**: exigiria expor a API (tunnel/porta) para ganhar o que o sinal interno do deploy já entrega. O repo é escrito por nós, de dentro.
- **Ler JSON cru do GitHub por requisição**: ponto único de falha externo no caminho mais quente (login/abertura de tela). O working copy local resolve.

## 5. Etapas de implementação

> Cada etapa é autocontida, testável e reversível. Ordem obrigatória: E1→E6. Nenhuma etapa autorizada até o Alexandre dar o go.

---

### E1 — Criar o repositório de configs e migrar o estado atual

**Decisões desta etapa**
- Nome do repo: `biblioteca-configs` (proposto; confirmar). Branch `main` = produção.
- Layout: `projects/<slug>.json` — um arquivo por projeto; campo reservado `_docs` (string) no topo para a narrativa de domínio; opcionalmente `<slug>.md` irmão para docs longas.
- O commit inicial é **neutro**: reproduz exatamente a config hoje vigente no banco de cada projeto ativo.

**Como será feito**
1. Criar repo no GitHub (decisão do Alexandre — deploy/publicação é exclusiva dele).
2. Script `database/export-configs.ts` (one-shot): conecta ao core, lê `projetos.config` de cada projeto ativo, valida cada JSON contra `geradorSistemaConfigSchema` + `validarConfigContraSchema`, escreve `projects/<slug>.json` e faz o commit inicial.
3. Teste de round-trip: `banco → JSON → parse → deep-equal ao original`.
4. Conferir o `sha`/conteúdo de cada projeto manualmente antes de qualquer uso em runtime (aceite do Alexandre).

**Critério de aceite:** todo projeto ativo tem seu JSON no repo novo, byte-a-byte equivalente à config do banco; script de export é idempotente e re-rodável.

---

### E2 — Working copy no host + API lendo do disco

**Decisões desta etapa**
- Diretório no host: `/home/alexandre/configs/biblioteca-configs` (proposto; confirmar — mesmo padrão do `mysql-data`: pasta do host sobrevive a recriação de container).
- Bind mount **read-only** para o container da API (`/config-repo`); escrita no working copy fica restrita ao mecanismo de refresh (E3), que roda com credencial própria — a aplicação nunca tem git de escrita no caminho quente.
- Mudança no `infra/docker/compose.biblioteca.yaml` é **plano apresentado ao Alexandre** (regra do workspace: quem decide deploy é ele).
- `core.projetos.config` passa a **legado**: permanece no banco como cache/consultoria, mas nenhum leitor de runtime a usa a partir daqui.

**Como será feito**
1. Novo `ConfigService` no `apps/api`: carrega `projects/<slug>.json` em memória com cache por sha; expõe `obterConfig(projeto)`; loga `sha@data` (visibilidade de staleness — P7).
2. `GeradorSistema`/CRUD (o que resolve config hoje via banco) passa a consultar `ConfigService`.
3. Fallback em cascata: working copy ok → serve; último bom em memória → serve + loga; nada legível → erro claro (nunca config "muda" silenciosa).
4. Boot: verificação + auto-cura (clone se vazio/corrompido; `fetch+reset` se são).
5. Testes: unit do parser/cache; integrado com fixture de repo temporário; teste do cenário "volume vazio".

**Critério de aceite:** API serve telas a partir do JSON do repo local; nenhuma leitura de config do banco no caminho de runtime; typecheck/lint/testes/build verdes.

---

### E3 — Refresh por sinal: "quem muda, avisa"

**Decisões desta etapa**
- Endpoint interno `POST /api/config/refresh` (aceita `{ slug?, sha? }`), protegido por **token de serviço** (env, rede local) — não exposto a usuários finais.
- O refresh executa `fetch + reset --hard` no working copy e recarrega o `ConfigService` na mesma request; resposta inclui o sha aplicado.
- Botão "Sincronizar config" na UI administrativa chama o mesmo endpoint (caso 4 da tabela de fluxo).
- **Nenhum timer/polling/webhook** — reconciliação extra acontece só no boot (E2).

**Como será feito**
1. Implementar endpoint + serviço de git local (child process, `--ff`/`reset --hard`, timeout, saneamento de erro).
2. Invalidação de cache atômica: troca por snapshot novo (sem servir config meio-aplicada).
3. Testes: refresh com commit novo aplicado; refresh idempotente (sha igual → noop); falha de rede → mantém último bom + erro estruturado.

**Critério de aceite:** após `git push` no repo de configs (feito por qualquer meio), uma chamada ao refresh faz a API servir o conteúdo novo em < 1s, sem reiniciar nada.

---

### E4 — Integração do Motor (pull na task, push no deploy)

**Decisões desta etapa**
- Início de task que toca config: motor lê `projects/<slug>.json` @ sha X e **registra X na task** (base de comparação do push condicional).
- Deploy do motor = `code push` + `config push` **juntos** (task que alterou config). Task sem mudança de config não empurra JSON.
- Merge estruturado: o writeback **nunca** é "arquivo inteiro do worktree"; é `montarConfigInicial(configCentralAtual, tabelasDoSchemaNovo, annotations)` reaplicando o delta sobre o estado vigente do repo (P5).
- Push condicional: só escreve se o sha-base confere; divergiu → re-fetch, reaplica delta sobre o novo; colisão semântica (ex.: humano ocultou campo que a task mexe) → **gate falha e avisa**, não escolhe por ninguém.
- Política inicial: **motor commita direto na branch de produção** (mesma do código dele). Modo gated (branch protegida + PR, API serve último sha aprovado) fica desenhado como flag de config do motor, para ligar depois sem mudança estrutural.
- `deploy_requests` ganha colunas `config_repo` + `config_sha` (auditoria cruzada P7).

**Como será feito**
1. Alterações no pipeline do motor (`projects/gerenteagentes/motor-v3`): leitura na abertura de task, escrita no passo de deploy, chamada ao `POST /api/config/refresh` ao final; refresh não-200 ⇒ deploy marcado failed (deploy incompleto é deploy falho).
2. Testes do motor com repo de configs temporário (padrão já usado nas suítes): cenário happy path; cenário conflito designer×motor (humano editou entre pull e deploy → motor reaplica sem perder a edição humana); cenário falha de refresh.
3. Registrar em `deploy_requests` os dois shas e linkar nos relatórios de aceite.

**Critério de aceite:** task que adiciona coluna via migração faz o campo chegar à tela de produção pelo fluxo automático (deploy único), sem intervenção; edição prévia do designer na mesma tela **sobrevive** ao deploy seguinte do motor; ambos os shas auditáveis.

---

### E5 — Modo Designer na UI (usuário mestre)

**Decisões desta etapa**
- Gate: perfil/`sub` de usuário mestre validado **no backend** ao salvar e ao expor o modo (a UI consulta "posso designar?" e a checagem real é server-side — P6).
- Escopo do que o designer pode: label, ocultar/mostrar por contexto (grid/insert/edit), adicionar campo do pool do schema, propriedades de apresentação (tipo, required, placeholder, mask, fullWidth + **novas**: `width` e `ordem` de coluna). **Proibido**: renomear campo, tocar `schema.ts`/migrations, editar JSON que não seja o do projeto do token.
- Save único destino: o `projects/<slug>.json` do repo de configs (a API é o braço executor: valida → commita → empurra → aplica no working copy → invalida cache — tudo na mesma request; push falhou ⇒ outbox re-tenta e UI mostra ⚠️; banco nunca é destino).
- UI: toggle "Editar tela" no header da grid/form; labels clicáveis (inline edit); X para ocultar coluna; botão "+ campo" com dialog do pool (campos do schema ainda não exibidos); painel de propriedades por campo (popover).

**Como será feito**
1. `packages/shared`: estender `dynamicFieldConfigSchema`/overrides com `width`/`ordem` (opcionais, backward-compatible — API pública sagrada preservada).
2. `packages/schema-tools`: endpoint/consulta "campos disponíveis do schema" (pool para o dialog) — reuso do `gerarFields`/`coletarTabelas`.
3. `apps/api`: `POST /designer/projeto/:id/config` (valida contra Zod + schema do projeto, monta JSON, commita via mecanismo da E3 com credencial de escrita, responde sha+estado).
4. `packages/ui` + `apps/web`: componentes do modo designer (DesignModeProvider, edição inline de label, dialog de campos, painel de propriedades), sem HTTP na UI (regra: transporte no `api-client`).
5. Testes: contrato de validação (campo inexistente no schema → rejeita; rename → rejeita), testes de componente do designer, teste funcional do save (API com repo temporário).

**Critério de aceite:** mestre edita label, oculta campo, adiciona campo do banco à grid e ajusta largura; ao salvar, o JSON vira commit no repo (blame = usuário) e a tela reflete na hora; não-mestre não vê nem consegue acionar nada; round-trip completo testado.

---

### E6 — Encerramento: seed, `config.ts` e documentação

**Decisões desta etapa**
- `database/seed.ts`: **para de escrever config** em projetos existentes (elimina a armadilha do upsert). Passa a: criar projeto com config vazia/referência ou importar do repo de configs (comportamento exato a definir na etapa — preferido: seed lê o JSON do repo se disponível).
- `projects/<slug>/config.ts` no repo de código: vira **wrapper documentado** que re-exporta do repo de configs (ou é removido se o time concordar); comentários de domínio migram para `_docs`/`<slug>.md`.
- `MEMORY`/PoC: registrar a mudança de fonte (banco → git de dados) como decisão arquitetural no `POC_DEFINICOES.md` e atualizar `docs/MANUAL_CONFIG_PROJETOS.md`.
- Limpeza opcional da coluna `core.projetos.config` só após 1 ciclo de estabilidade (destruição de dados é decisão do Alexandre).

**Como será feito**
1. Ajustar seed + testes do seed (idempotência, projeto novo sem JSON no repo → provisioning funciona com config mínima).
2. Migrar headers narrativos (ex.: `projects/taqui/config.ts`) para `_docs` dos JSONs correspondentes, com revisão humana do diff.
3. Atualizar PoC/manual + nota de memória. Rodar suíte completa (typecheck, lint, test, build).

**Critério de aceite:** nenhum caminho de código escreve config em `core.projetos.config`; re-executar seed não altera telas de projeto existente; narrativa de domínio preservada e visível no repo de configs; documentação oficial atualizada.

---

## 6. Riscos residuais (honestos)

1. **Motor comitando direto na produção (fase inicial)** — atenuado pelo gate de testes do motor + blame + rollback por revert; modo gated pronto para ligar se o histórico mostrar config não aprovada entrando.
2. **Duas fontes durante a transição (E2→E6)** — o banco ainda tem config antiga; regra de transição: a partir da E2 só o repo é lido, a coluna vira reliquíade intocável.
3. **Volume do host indisponível** (disco 12T/montagem — ver INFRA.md) — working copy das configs fica em `/home/alexandre`, não no 12T, para reduzir superfície; falha de leitura → erro claro, nunca config errada.
4. **Sanitizer/ambiente do container** — git via child process dentro do container da API precisa de credencial mínima (deploy key read-write restrita ao repo de configs); nada de token do repo de código.

## 7. Registro de conversa

- 18:18 — ideia do modo designer; viabilidade confirmada (overrides já expressam 1–4 como dado).
- 18:26 — como puxar mudanças do banco pro código (export/proposta inicial).
- 18:33 — por que o `config.ts` existe (provisão, revisão, contrato no build); achado: seed é upsert e sobrescreve config — pré-requisito de segurança.
- 18:38 — variante "salvar no banco E no arquivo, regerar config.ts, push na branch" — problema dos dois escritores apontado.
- 18:43 — documentação viva: dados no JSON, história em `_docs`/`.md`, robô nunca toca texto humano.
- 18:53 — **virada**: repo git separado só de configs; API lê do repo, não do banco.
- 19:00 — commit = deploy da config; motor comita no deploy, designer comita no save; política gated opcional.
- 19:04 — a API NÃO lê do GitHub por request: working copy local sincronizado.
- 19:10 — clone no setup único (day 0) + auto-cura no boot; volume sobrevive a recriação de container.
- 19:15 — "quem muda, comita e empurra no evento"; sem fila de JSON aguardando deploy; sem flag de pull.
- 19:38 — **polling eliminado**: refresh por sinal (save do designer, fim de deploy do motor, botão manual); reconciliação implícita no boot.
- 21:39 — este documento (decisões + etapas E1–E6).
