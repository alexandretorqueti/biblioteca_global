# Especificação — Calculadora de Investimentos Gabriel

## Visão geral
Aplicação web de uso pessoal que projeta o rendimento de um investimento. O usuário informa o valor (depósito único ou mensal), escolhe um índice de mercado (CDI, Selic, IPCA, Ibovespa) — com cotação automática da taxa atual via API pública — ou digita uma taxa manual, define o prazo em anos e recebe o valor final projetado com gráfico de crescimento. Resolve a necessidade de simular investimentos rapidamente, sem procurar taxas na mão nem fazer contas de juros compostos.

## Atores/papéis
- Gabriel — proprietário e único usuário do sistema.

## Requisitos funcionais
- RF-1: O sistema é de uso exclusivo do Gabriel, sem acesso para terceiros.
- RF-2: No aporte, o usuário escolhe entre depósito único ou depósitos mensais recorrentes.
- RF-3: O sistema oferece uma lista de índices selecionável (CDI, Selic, IPCA, Ibovespa, etc.), com busca automática do valor atual da taxa via API pública (Banco Central/SGS).
- RF-4: O sistema oferece campo livre para digitar manualmente uma taxa quando o índice desejado não estiver na lista.
- RF-5: Para o Ibovespa, o sistema usa a variação histórica do índice como taxa de crescimento do investimento.
- RF-6: O sistema converte automaticamente a taxa anual obtida para taxa mensal (juros compostos); apenas a taxa mensal é exibida e alimenta a projeção.
- RF-7: O resultado exibe o valor final da projeção e um gráfico de crescimento com alternância entre visão ano a ano e mês a mês.

## Requisitos não-funcionais
- Simplicidade: ferramenta de uso rápido e direto, sem cadastro de simulações.
- Acessibilidade: aplicação web rodando no navegador (computador e celular), com layout responsivo sem exageros.
- Desempenho: cálculo da projeção instantâneo; a cotação dos índices depende do tempo de resposta da API pública.
- Segurança/privacidade: uso pessoal, dados do usuário não são compartilhados com terceiros.
- Volume: 1 usuário, carga desprezível.

## Entidades de dados
- Simulação (efêmera): valor do aporte, modo de aporte (único ou mensal), índice selecionado ou taxa manual, prazo em anos, taxa mensal convertida.
- Resultado da projeção: valor final, pontos de evolução (série anual e mensal para o gráfico).
- Índice: nome, taxa atual (anual e mensal derivada), fonte da cotação.

## Integrações
- API pública do Banco Central (SGS) para cotação de CDI, Selic, IPCA e Ibovespa (fonte alternativa em avaliação pela equipe técnica, ex.: BrasilAPI).

## Fora de escopo
- Salvar ou consultar histórico de simulações (cálculo descartável).
- App nativo para celular.
- Múltiplos usuários, cadastro ou login de terceiros.
- Conexão com contas bancárias/corretoras reais ou execução de investimentos.
