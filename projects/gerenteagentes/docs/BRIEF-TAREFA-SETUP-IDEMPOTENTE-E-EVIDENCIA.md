# BRIEF — Missão de setup idempotente + evidência smoke_test obrigatória no formato de máquina

**Data:** 2026-11-19
**Origem:** incidentes reais do mesmo dia (projetos 13 e 2)
**Tipo sugerido:** desenvolvimento · **Projeto:** Gerente Agentes (motor/plataforma)

## Contexto (incidentes)

1. **Evidência de smoke test em prosa reprova o setup inteiro.**
   - Projeto 13 (gestao-de-tarefas-global), 19/11 11:50: setup reprovado na reconciliação de conclusão — "nenhum resultado de subtarefa verified com evidência smoke_test JSON válida".
   - Projeto 2 (gerenteagentes), 19/11 ~20:30: tarefa 1101 — AMBAS as subtarefas (1552, 1553) `verified`, smoke test EXECUTADO de fato, mas o DEV gravou o resultado como texto livre (`::DONE:: ... comandos curl ...`) sem o bloco JSON `{"smoke_test":{url,method,status,response_body,timestamp}}`. A reconciliação `development_flow` reprovou → `setup_status='failed'` → macro 1100 e futuras travadas no gate `setup_not_verified`.
   - Causa: o template da missão (PASSO 4.3) pede a evidência JSON, mas nada na cadeia (briefing do DEV, validação de entrega, gate de subtarefa) garante que o resultado final a contenha no formato de máquina. O trabalho é feito e jogado fora na reconciliação.

2. **Missão de setup é escrita para projeto NOVO e sobrescreve/recria o que já existe.**
   - `montarMissaoSetup()` (`projects/gerenteagentes/api/gerenteagentes.service.ts`, ~L3696) gera instruções "crie a pasta / crie CONTEXTO-ANALISTA.md a partir do modelo / crie o banco" sem verificar o estado atual.
   - Para projetos existentes (re-setup após `failed`), o risco é sobrescrever artefatos ricos — caso histórico: subtarefas 1516–1518 (04–05/11) recriaram SÓ o esqueleto do gestao-de-tarefas-global e apagaram conteúdo do `docs/CONTEXTO-ANALISTA.md` (memória transversal do Analista).
   - Em 19/11 o Analista se saiu bem por conta própria (tratou como verificação), mas isso é sorte de modelo, não garantia de projeto.

## Objetivo

Tornar o fluxo de setup (a) idempotente para projetos existentes e (b) impossível de concluir sem a evidência smoke_test no formato de máquina.

## Escopo

Arquivo principal: `projects/gerenteagentes/api/gerenteagentes.service.ts`
(`montarMissaoSetup` e, se aplicável, `montarMissaoSetupStandalone`.)
+ ponto de validação no motor-v3 onde a reconciliação de conclusão do setup lê `subtarefas.resultado` (manter comportamento atual do gate; a mudança é na GERAÇÃO da missão e nas instruções ao DEV).

## Requisitos

### A. Missão idempotente (projeto existente)

- Ao montar a missão, detectar o estado atual do projeto (pasta `projects/<slug>` existe? `docs/CONTEXTO-ANALISTA.md` existe e tem conteúdo além do template bootstrap? `docs/ESPECIFICACAO.md` existe? registros 2.1–2.7 já presentes? banco `projeto_<id>` existe? migrations aplicadas?).
- Se o projeto (ou parte) já existe, a missão DEVE:
  - iniciar com seção explícita "PROJETO JÁ EXISTENTE — MODO VERIFICAÇÃO";
  - instruir: **verificar cada artefato; criar SOMENTE o que estiver faltando; NUNCA sobrescrever ou "regenerar" arquivo existente** (em especial `CONTEXTO-ANALISTA.md`, `ESPECIFICACAO.md`, registries, seeds);
  - listar na própria missão o que já foi detectado como existente (estado real no momento da montagem), para o DEV não gastar sessão redescobrindo;
  - migrations: apenas aplicar as pendentes (drizzle é incremental — instruir a não resetar/recriar banco existente).
- Projeto novo: comportamento atual preservado integralmente.

### B. Evidência smoke_test inegociável

- Reforçar no PASSO 4 da missão: o resultado FINAL da última subtarefa DEVE conter o bloco JSON exato `{"smoke_test":{"url":...,"method":...,"status":...,"response_body":...,"timestamp":...}}` — e que resultado em prosa (mesmo com comandos e prints) **reprova o setup e desperdiça a execução**.
- Fornecer no template o comando pronto para validar antes de concluir (ex.: `jq '.smoke_test.status' <<< "$RESULTADO"` ou equivalente) e instruir o DEV a auto-checar o formato antes de marcar `::DONE::`.
- (Opcional, se barato) no gate/reconciliação: quando reprovar por evidência ausente, gravar em `setup_error` a instrução exata do formato esperado — já grava parcialmente; garantir que o texto inclua o schema JSON.

### C. Testes

- Teste unitário da montagem da missão:
  - projeto inexistente → missão atual (snapshot/contém instruções de criação);
  - projeto existente com artefatos → missão contém "MODO VERIFICAÇÃO", contém a lista de artefatos detectados, e NÃO contém instrução de sobrescrever `CONTEXTO-ANALISTA.md`;
  - ambas → missão contém o schema JSON da evidência smoke_test e o aviso de reprovação por prosa.
- Build + typecheck + suíte do motor-v3 verdes.

## Fora de escopo

- Mudar o formato que a reconciliação `development_flow` aceita como evidência (o gate continua exigindo o JSON — quem se adapta é a missão/DEV).
- Re-disparo automático de setups `failed` (isso é o escopo B do `BRIEF-TAREFA-VISIBILIDADE-SETUP-NOT-VERIFIED.md`).
- Suporte standalone (tarefa 1092 cuida; apenas não conflitar — se `montarMissaoSetupStandalone` já existir no momento do desenvolvimento, aplicar o mesmo tratamento A/B nela).

## Critérios de aceite

1. Re-setup de projeto existente gera missão em modo verificação, com inventário do que já existe e proibição explícita de sobrescrita.
2. Setup de projeto novo continua idêntico ao comportamento atual.
3. Missão contém schema JSON da evidência + auto-checagem para o DEV; testes unitários cobrem os 3 casos da seção C.
4. Deploy via `deploy.sh` (blue-green); smoke pós-deploy conforme runbook.
5. Validação prática: re-disparar "Iniciar desenvolvimento" do gerenteagentes (projeto 2) após o deploy → setup conclui `verified` com evidência JSON presente em `subtarefas.resultado` → tarefa 1100 é despachada automaticamente.
