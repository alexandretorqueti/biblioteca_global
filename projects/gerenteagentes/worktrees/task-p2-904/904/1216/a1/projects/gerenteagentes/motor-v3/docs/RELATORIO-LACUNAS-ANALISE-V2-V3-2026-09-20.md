# Relatório: análise de tarefas — Motor v2 x Motor v3

Data: 2026-09-20  
Escopo: fluxo desde o recebimento de uma tarefa elegível até a persistência
atômica do plano (ou a solicitação de esclarecimentos). Este documento não
avalia a execução/programação das subtarefas.

> Atualização de implementação: prompt/contrato administrado, normalização e
> validação de cobertura, retry corretivo e cadeia de modelos com cooldown
> foram implementados no v3 após esta avaliação. As lacunas de coordenação
> distribuída, protocolo completo do Console e observabilidade administrativa
> continuam no backlog. A migração/bootstrap automático seguro foi concluída
> no fluxo canônico do GerenteAgentes.

> Em 2026-09-21, o contexto longo do analista também passou a ser enviado em
> blocos de 6.000 caracteres. Cada bloco exige a confirmação literal
> `CONTEXTO_RECEBIDO`; o prompt final só é enviado após todas as confirmações
> e a composição auditada registra quantidade de blocos e tamanho da descrição.
> Em 2026-09-21, o mesmo padrão foi aplicado ao programador: acima de 12.000
> caracteres, a descrição da missão é enviada em mensagem separada (até 30.000
> caracteres), antes do header que inicia a execução. Para descrições menores,
> ela permanece no header.

## Conclusão executiva

O Motor v3 já possui a base para iniciar uma análise de forma durável:
outbox, consumidor RabbitMQ, claim atômico, sessão no Console, parser e
persistência transacional do plano. Ele ainda não tem as salvaguardas que o
Motor v2 usa para tornar a análise governável, auditável e recuperável.

O caso da tarefa 840 ilustra a diferença: a sessão usou o modelo configurado
corretamente, retornou um plano semanticamente útil, mas a divergência entre a
saída e o parser encerrou a tentativa sem feedback corretivo nem tentativa do
próximo modelo. No v2, esta situação entra no ciclo de correção e escalonamento.

A prioridade é fazer o v3 consumir a mesma fonte administrável de prompt e
contrato exibida na tela de Prompts. Não se deve manter uma segunda assinatura
JSON codificada em `ConsoleAnalystRunner`.

## Fluxo efetivo do Motor v2

1. **Seleção e elegibilidade.** `TaskCoordinator.selectNextTask` seleciona
   apenas tarefa não terminal, sem plano, sem análise já iniciada, sem bloqueio
   aberto e sem esclarecimento pendente. A retomada considera o estado de
   negócio, não apenas a mensagem de fila.
2. **Exclusão e preflight.** `startTaskAnalysis` obtém lease global com fence,
   registra execução ativa e heartbeat, valida o manifesto/ambiente quando
   aplicável e registra a transição `start_analysis` antes de gastar modelo.
3. **Cadeia de modelos.** `getProjectModelChain(projectSlug, "analysis")`
   lê todos os `ANALYST` habilitados em `project_model_selection`, por `ordem`.
   Modelos em cooldown são ignorados; indisponibilidade marca cooldown e leva
   ao próximo candidato.
4. **Prompt administrado e contrato.** `TaskWorker.phaseAnalyze` resolve
   `analista.primeira_rodada_tarefa` ou
   `analista.retomada_apos_clarificacao` através de `ManagedPromptResolver`.
   O resolver busca a versão ativa e o contrato vinculado nas tabelas de
   prompts, renderiza as máscaras, grava `prompts_execucoes` e registra a
   composição final. Há fallback somente para bootstrap da configuração.
5. **Sessão e contexto.** O worker cria sessão do Console com chave estável e
   modelo explícito, envia contexto adicional quando a descrição é grande e
   conserva/persiste o histórico da sessão para auditoria.
6. **Resposta, correção e escalonamento.** A resposta é validada pelo parser.
   JSON inválido ou truncado recebe uma tentativa corretiva no mesmo modelo,
   com o contrato completo. Persistindo a falha, o worker tenta o próximo
   modelo da cadeia.
7. **Esclarecimentos.** Se o resultado for perguntas, elas são persistidas em
   canal próprio. A resposta posterior é reinjetada no prompt de retomada; a
   tarefa não volta à seleção como se estivesse sem contexto.
8. **Qualidade do plano.** `validatePlanQuality` verifica o plano e a
   cobertura. Reprovação gera uma tentativa corretiva de qualidade antes do
   escalonamento. Há regra adicional para inserir smoke test em tarefa de
   setup quando necessário.
9. **Finalização.** `persistPlan` trava a tarefa, não sobrescreve plano já
   existente, cria subtarefas/dependências e cobertura na mesma transação.
   O coordenador registra `analysis_completed`, libera lease/executação ativa
   e permite a próxima fase. Falhas e reinícios são reconciliados por
   heartbeat, lease e estado persistido.

## O que o v3 já entrega

- Estado derivado da tarefa em `DerivedTaskStatusResolver` para o mapa e para
  a decisão de negócio.
- Outbox e consumidor duráveis, retry e DLQ RabbitMQ, claim de análise no
  banco e recuperação no boot de processamento abandonado com mais de cinco
  minutos.
- Sessão no Console, timeout/polling, persistência transacional de perguntas
  ou de subtarefas/dependências/cobertura e idempotência básica quando já há
  subtarefas.
- Seleção do primeiro modelo `ANALYST` habilitado do projeto e envio explícito
  dele ao Console.

Esses componentes são insuficientes para equivalência funcional com o v2:
`ConsoleAnalystRunner` ainda monta um prompt fixo e `parseAnalystReply` ainda
é a única validação/reação à resposta.

## Lacunas e prioridade

| Prioridade | Lacuna | Impacto e entrega necessária |
|---|---|---|
| P0 | Prompt e contrato administrados | Integrar `ManagedPromptResolver` (ou extrair o módulo compartilhado do v2) ao v3. Usar a chave correta por primeira análise/retomada, renderizar máscaras e gravar execução, versão, contrato e composição final. A tela de Prompts passa a ser efetivamente a fonte de verdade do Motor v3. |
| P0 | Parser orientado pelo contrato e ciclo corretivo | Validar JSON contra o contrato ativo, normalizar aliases compatíveis quando definidos e validar cobertura/qualidade. Para falha de sintaxe, contrato ou qualidade, enviar um único feedback corretivo ao mesmo modelo antes de falhar. O erro da tarefa 840 (`requirement_id`/`subtasks` versus `requirement`/`covered_by`) deve ser tratado aqui, sem tornar a tela de Prompts decorativa. |
| P0 | Cadeia completa de modelos | Substituir a seleção de `LIMIT 1` por todos os ANALYST habilitados por ordem. Implementar cooldown persistido, classificação de indisponibilidade e fallback após resposta inválida, timeout ou erro do provedor. |
| P0 | Migrações v3 no deploy | Garantir que o entrypoint de produção execute as migrações Drizzle do `motor-v3` antes de iniciar o consumidor e falhe de forma visível se o schema estiver atrasado. A coluna `analysis_execution_id` ter exigido aplicação manual prova que esta garantia não existe hoje. |
| P0 | Recuperação de fila previsível | A recuperação de claims abandonados deve reencaminhar a mensagem com política explícita de tentativas. Hoje o contador preservado pode levar uma mensagem recuperada diretamente à DLQ. Incluir reprocessamento administrativo de DLQ e reconciliação de claim/sessão antes de liberar nova análise. |
| P1 | Protocolo e auditoria de sessão Console | Registrar `sessionId`, `sessionKey`, `runId`, modelo/provedor, prompt final, resposta e erro técnico. Usar idempotency key, cancelamento e timeout do run; não inferir conclusão só de polling genérico da sessão. |
| P1 | Esclarecimento completo | Persistir perguntas com metadados estruturados, impedir seleção enquanto aguardam humano e reinjetar histórico na retomada usando o prompt específico. O v3 hoje grava texto no chat, mas não fornece o ciclo completo. |
| P1 | Validador de plano | Portar/extrair `validatePlanQuality`, incluindo integridade de sequências, dependências, cobertura de requisitos e regra de smoke test para setup. Manter persistência idempotente por transação. |
| P1 | Coordenação operacional | Adicionar lease/fencing, execução ativa, heartbeat, timeout e reconciliador de análise para sobreviver a reinício no meio de uma sessão sem duplicar trabalho ou manter tarefa presa. |
| P2 | Observabilidade e operação | Timeline persistente por execução (selecionada, iniciada, sessão, retry, fallback, concluída/falhou), consulta de outbox/DLQ e ação administrativa segura de reprocessar. |
| P2 | Testes integrados | Cobrir em integração: reinício durante análise, publicação duplicada, timeout, resposta inválida seguida de correção, fallback de modelo, esclarecimento/respondido e schema ausente no deploy. |

## Ordem recomendada de desenvolvimento

1. **P0 — contrato/prompt, parser e retry corretivo.** Primeiro porque evita
   perda de análises válidas e alinha o runtime à tela já existente.
2. **P0 — cadeia de modelos e cooldown.** Em seguida, para que quota,
   indisponibilidade e falha após a correção não parem uma tarefa.
3. **P0 — migrações e recuperação de fila.** Fecha as falhas de deploy e de
   reinício observadas no ambiente real.
4. **P1 — sessão, esclarecimento, qualidade e coordenação operacional.**
   Fecha equivalência do fluxo de análise do v2.
5. **P2 — observabilidade e testes de cenário.** Torna a operação verificável
   sem depender de inspeção manual em banco e logs.

## Critérios mínimos para declarar o v3 apto para análise

- Uma alteração na tela de Prompts/contratos é usada pela próxima análise do
  v3 e fica auditável por tarefa.
- Um JSON inválido recebe feedback corretivo; uma nova falha ou indisponibilidade
  tenta o próximo modelo habilitado, respeitando cooldown.
- Uma resposta de esclarecimento bloqueia seleção e é reaproveitada na
  retomada.
- Reiniciar o Motor durante análise não perde mensagem, não duplica plano e
  não deixa claim indefinido.
- Um deploy em banco sem migração não inicia o consumidor silenciosamente.
- O plano persistido tem subtarefas, dependências e cobertura válidas, e a
  conclusão fica visível no status derivado e na timeline operacional.

## Evidências consultadas

- `motor-v2/src/coordinator/TaskCoordinator.ts` — seleção, lease, transições,
  cadeia de modelos e finalização.
- `motor-v2/src/workers/TaskWorker.ts` — análise, sessão, retries, fallback,
  esclarecimento e validação de qualidade.
- `motor-v2/src/prompts/ManagedPromptResolver.ts` — prompts/contratos
  versionados e auditoria de composição.
- `motor-v2/src/planning/PlanPersistence.ts` — persistência idempotente do
  plano.
- `motor-v3/src/analysis/ConsoleAnalystRunner.ts` e `AnalystReply.ts` —
  prompt fixo e parser atual.
- `motor-v3/src/coordinator/TaskCoordinator.ts` e
  `MySqlTaskCoordinatorRepository.ts` — claim e persistência atuais.
- `motor-v3/src/queue/OutboxPublisher.ts` e `start.ts` — recuperação de fila
  e bootstrap atual.

Nenhuma mudança de comportamento ou deploy foi feita para produzir este
relatório; ele registra a comparação do código em 2026-09-20.
