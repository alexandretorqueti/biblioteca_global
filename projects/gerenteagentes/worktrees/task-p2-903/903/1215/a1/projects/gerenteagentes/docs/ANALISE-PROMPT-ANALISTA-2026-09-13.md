# Diagnóstico — contexto e contrato do Analista

Registro de 2026-09-13, solicitado por Alexandre. Este documento é uma análise; não altera o prompt ativo nem o comportamento do Motor.

## Fonte analisada

- `motor-v2/src/workers/TaskWorker.ts` (`buildAnalystPrompt`), fallback executável;
- `docs/MAPEAMENTO_PROMPTS_AGENTES.md`;
- `docs/ANALISTA_INTERATIVO_CHAT.md`;
- `docs/P2-PROMPTS-E-REFUTACAO-DE-PREMISSA.md`;
- `docs/REVISAO-FINAL-PELO-ANALISTA.md`.

Os prompts persistidos ativos foram consultados diretamente em `projeto_640` em 2026-09-13. O Motor resolve `prompts_agentes.versao_ativa_id` e usa `prompts_versoes.texto`; o campo `conteudo` da tabela de prompts não é a fonte da execução.

| Chave | Versão ativa | Contexto/contrato adicional |
|---|---:|---|
| `analista.primeira_rodada_tarefa` | 6 (id 23) | contrato de saída v4 |
| `analista.retomada_apos_clarificacao` | 5 (id 19) | nenhum |
| `analista.retry_resposta_invalida` | 1 (id 4) | nenhum |
| `analista.revisao_premissa_incorreta` | 1 (id 9) | nenhum |

## O contrato atual

Na primeira rodada, o Analista recebe título, descrição integral e tipo da tarefa. O prompt ativo v6 exige leitura de `AGENTS.md`, `TOOLS.md`, `INFRA.md`, documentação, runbooks, configurações não sensíveis e arquivos relevantes; também pede identificação de namespaces/containers/host, planejamento de baixo para cima e análise de dependências antes de dividir o trabalho. O contrato de saída v4 exige JSON, requisitos, cobertura, estratégia, invariantes, artefatos compartilhados e ordem de execução.

Na retomada, ele recebe título, descrição e histórico de clarificação, mas somente uma instrução genérica para inspecionar documentação/arquivos. Retry de JSON inválido e rebriefing após refutação têm apenas uma frase de instrução e não recebem o contrato completo.

O contrato já acerta ao exigir cobertura explícita, critérios verificáveis, perguntas em vez de inventar planos, persistência do histórico e refutação de premissa pelo executor com auditoria determinística.

## Lacunas prioritárias

1. A primeira rodada melhorou, mas não recebe identidade operacional estruturada: repositório canônico, branch base, projeto/slug, stack, comandos de validação, fontes de verdade e permissões ainda dependem de descoberta livre.
2. A retomada após clarificação não repete as regras fortes de ambiente, namespace, investigação e estratégia da primeira rodada. Uma resposta humana pode, assim, reabrir uma análise com menos contexto do que a que a originou.
3. Retry de JSON inválido e rebriefing de premissa incorreta são minimalistas e não reaplicam contrato de saída, critérios de descoberta ou contexto da tarefa. O rebriefing é especialmente frágil porque deveria reexaminar requisito, evidência, dependências e impacto no plano.
4. Não separa explicitamente fato observado, hipótese e decisão de produto. Isto permite transformar suposições em escopo executável.
5. Os critérios de aceite cobram que sejam verificáveis, mas não exigem método de verificação, evidência esperada ou responsável pela validação.
6. A regra de "somente trabalho de código ou documentação" é ampla demais: não orienta como tratar investigação, migração de dados, configuração de ambiente, integrações externas ou trabalho pertencente à plataforma Biblioteca.
7. O contrato ativo contém texto com codificação corrompida (`AlÃ©m`, `vÃ¡rias`, `orquestraÃ§Ã£o`). Embora compreensível, deve ser republicado em UTF-8 correto para não degradar a instrução do modelo.
8. Há inconsistência documental: `REVISAO-FINAL-PELO-ANALISTA.md` prevê uma sessão lógica contínua até a aprovação final, enquanto `MAPEAMENTO_SESSAO_ANALISTA_TAREFA.md` descreve sessões efêmeras por modelo/tentativa. O comportamento canônico precisa ser decidido e implementado/documentado de forma única.

## Direção recomendada

Transformar o prompt em contrato por fases:

1. **Descobrir:** ler fontes obrigatórias e devolver um inventário curto de evidências, lacunas e conflitos.
2. **Decidir:** declarar entendimento, premissas, decisões reversíveis e perguntas bloqueantes. Sem evidência suficiente, usar clarificação.
3. **Planejar:** produzir subtarefas pequenas com escopo, não-escopo, arquivos/componentes prováveis, dependências, critérios e evidência de aceite.
4. **Revisar:** conferir cobertura requisito→subtarefa e validar que cada item pertence ao projeto e ao agente executor corretos.

O Motor deve injetar um pacote de contexto estruturado, preferencialmente pequeno e com origem explícita, em vez de depender de texto livre: identidade do projeto, caminho/branch, fontes obrigatórias, resumo do estado técnico, contratos relevantes, limitações de ambiente e decisões já registradas.

## Próximo passo seguro

Extrair a versão efetivamente ativa de `analista.primeira_rodada_tarefa` e comparar com o fallback antes de propor uma versão 2. Depois, definir um contrato de entrada/saída versionado e testes de qualidade do plano para cenários reais e premissas falsas.
