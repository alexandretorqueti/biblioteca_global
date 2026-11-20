# Brief de tarefa — Visibilidade de "setup_not_verified" no app (proposta 2026-11-19)

**Origem:** sessão webchat 18–19/11. Fila das tarefas 1063–1070 (gestao-de-tarefas-global) e
1083 (consoleopenclaw) parada em requeue infinito `capacity_waiting('setup_not_verified')`
sem que a aplicação comunicasse o motivo real. Evidências completas:
`memory/2026-11-18.md` (seções "Verificação 23:55–00:30" e INCIDENTE 19:27).

## Contexto do estado atual

- Front (Mapa de agentes / TaskFlowMap.tsx): `capacityWaitMessage` para
  `setup_not_verified` retorna frase genérica ("Aguardando o setup do projeto ser
  verificado...") sem causa, sem indicar se HÁ setup na fila, e sem ação sugerida.
- Motor (MySqlTaskCoordinatorRepository.ts:174): grava capacity wait com
  reason `setup_not_verified` e faz requeue 30s indefinido.
- `reconcileSetupCompletion`/Sweeper cobrem apenas setups `queued/running/pending`;
  projeto com `setup_status='failed'` fica em limbo silencioso — sem tarefa setup ativa,
  sem alerta, sem re-disparo. Único re-disparo existente: botão da plataforma
  (`dispararMissaoSetup`, gerenteagentes.service.ts:3545).
- Cadeia que produziu o caso: teardown do piloto removeu artefatos do projeto
  (`1ff565ad`), subtarefas recriaram o diretório SEM `docs/CONTEXTO-ANALISTA.md`,
  preflight da análise da 1063 falhou (18/11 23:03), `AnalysisFailureBlocker.recordProjectSetupFailure`
  (TaskCoordinator.ts:437) marcou o projeto `failed`, gate segurou tudo.

## Escopo (motor + app)

### A. Motor — diagnóstico rico no capacity wait
1. Ao gravar `recordCapacityWait('setup_not_verified')`, consultar `geracoes_projeto`
   do projeto e derivar sub-motivo: `setup_faltando` (nenhuma geração pending/queued/
   running), `setup_failed` (última geração falha/`setup_status=failed` — incluir
   `LEFT(erro, 300)` da geração), `setup_em_andamento`.
2. Persistir sub-motivo + mensagem do setup (quando houver) nos campos de payload da
   espera (task_runtime_facts / projeção consumida pela API), e expor em
   `GET /api/motor/task/:id` (`capacityWait.{setupState,setupError,detail}`).
3. Alerta: se `setup_faltando` ou `setup_failed` persistir > 30 min (marcos `since`),
   emitir evento/linhas para o Monitor (padrão dos demais reconciliadores) — sem spam
   (dedupe por projeto, janela configurável).

### B. Motor — re-disparo do setup (não dar o peixe)
4. Quando o gate reter por `setup_not_verified` E não houver setup
   `queued/running/pending` do projeto: reemitir `SETUP_REQUESTED` (missao setup) de
   forma idempotente, com backoff (ex.: 30 min) e contador; após N tentativas,
   permanecer em espera com alerta humano (item A.3). Nunca recriar setup se já
   existe um ativo.

### C. App — clareza na tela
5. `capacityWaitMessage` para `setup_not_verified` usar o sub-motivo:
   - `setup_failed`: "⚠ Setup do projeto FALHOU: <resumo do erro>. A fila está retida.
     Refaça o setup em Projetos → Iniciar desenvolvimento." + tooltip com detalhe.
   - `setup_faltando`: "Projeto sem setup concluído e sem missão de setup na fila —
     o motor está re-disparando (tentativa X em Y)."
   - `setup_em_andamento`: manter frase atual + "acompanhe em Projetos".
6. Chip com variante de severidade (warning vs error) e ícone com `data-testid`
   estável para teste.

## Critérios de aceite
- Dado o estado atual dos projetos 12 e 13 (setup failed, sem missão na fila), o
  detalhe das tarefas 1063 e 1083 no Mapa de agentes mostra em ≤1 ciclo de refresh o
  motivo "setup FALHOU" com o resumo do erro real do `geracoes_projeto`.
- Após o re-disparo automático (B.4), uma missão `setup-gestao-de-tarefas-global`
  aparece `queued/running` sem clique humano; tarefas seguem quando `verified`.
- Alerta único por projeto no período configurado (sem spam no Monitor).
- Testes: unit dos novos reason codes/sub-motivos; componente do chip cobre os 3
  sub-motivos; teste de integração do re-disparo idempotente (sem setup ativo →
  emite; com ativo → não emite; cap de tentativas).
- Sem SQL direto em tabelas de estado do motor para intervenções; fluxo canônico.

## Não-faz parte
- Corrigir manualmente os projetos 12/13 (destravamento fica com o próprio motor após
  a tarefa, ou pelo botão da plataforma enquanto isso).
- Redesenhar o gate de setup ou a missão de setup.
