# Diagnóstico — contexto e contrato do Analista

Registro de 2026-09-13, solicitado por Alexandre. Este documento é uma análise; não altera o prompt ativo nem o comportamento do Motor.

## Fonte analisada

- `motor-v2/src/workers/TaskWorker.ts` (`buildAnalystPrompt`), fallback executável;
- `docs/MAPEAMENTO_PROMPTS_AGENTES.md`;
- `docs/ANALISTA_INTERATIVO_CHAT.md`;
- `docs/P2-PROMPTS-E-REFUTACAO-DE-PREMISSA.md`;
- `docs/REVISAO-FINAL-PELO-ANALISTA.md`.

Como prompts persistidos ativos no banco prevalecem sobre o fallback, este diagnóstico deve ser confrontado com a versão publicada antes de qualquer alteração de produção.

## O contrato atual

O Analista recebe título, descrição integral, tipo da tarefa e, quando houver, histórico de clarificação. Deve devolver somente JSON: um plano de até dez subtarefas, requisitos `REQ-*`, matriz de cobertura, entregáveis, critérios de aceite e dependências; ou perguntas de clarificação, com resumo e até oito perguntas.

O contrato já acerta ao exigir cobertura explícita, critérios verificáveis, perguntas em vez de inventar planos, persistência do histórico e refutação de premissa pelo executor com auditoria determinística.

## Lacunas prioritárias

1. Não exige descoberta baseada em fonte de verdade antes de planejar. O Analista pode decompor uma descrição sem ler `AGENTS.md`, documentação do projeto, código, schema, contratos de API, testes ou estado atual do repositório.
2. Não recebe identidade operacional suficiente: repositório canônico, branch base, projeto/slug, worktree aplicável, stack, comandos de validação, limites de acesso e fontes de verdade relevantes.
3. Não separa explicitamente fato observado, hipótese e decisão de produto. Isto permite transformar suposições em escopo executável.
4. Os critérios de aceite cobram que sejam verificáveis, mas não exigem método de verificação, evidência esperada ou responsável pela validação.
5. A regra de "somente trabalho de código ou documentação" é ampla demais: não orienta como tratar investigação, migração de dados, configuração de ambiente, integrações externas ou trabalho pertencente à plataforma Biblioteca.
6. O contrato não força classificar risco/necessidade de decisão humana antes de gerar subtarefas. Clarificação existe, mas os gatilhos estão vagos.
7. Há inconsistência documental: `REVISAO-FINAL-PELO-ANALISTA.md` prevê uma sessão lógica contínua até a aprovação final, enquanto `MAPEAMENTO_SESSAO_ANALISTA_TAREFA.md` descreve sessões efêmeras por modelo/tentativa. O comportamento canônico precisa ser decidido e implementado/documentado de forma única.

## Direção recomendada

Transformar o prompt em contrato por fases:

1. **Descobrir:** ler fontes obrigatórias e devolver um inventário curto de evidências, lacunas e conflitos.
2. **Decidir:** declarar entendimento, premissas, decisões reversíveis e perguntas bloqueantes. Sem evidência suficiente, usar clarificação.
3. **Planejar:** produzir subtarefas pequenas com escopo, não-escopo, arquivos/componentes prováveis, dependências, critérios e evidência de aceite.
4. **Revisar:** conferir cobertura requisito→subtarefa e validar que cada item pertence ao projeto e ao agente executor corretos.

O Motor deve injetar um pacote de contexto estruturado, preferencialmente pequeno e com origem explícita, em vez de depender de texto livre: identidade do projeto, caminho/branch, fontes obrigatórias, resumo do estado técnico, contratos relevantes, limitações de ambiente e decisões já registradas.

## Próximo passo seguro

Extrair a versão efetivamente ativa de `analista.primeira_rodada_tarefa` e comparar com o fallback antes de propor uma versão 2. Depois, definir um contrato de entrada/saída versionado e testes de qualidade do plano para cenários reais e premissas falsas.
