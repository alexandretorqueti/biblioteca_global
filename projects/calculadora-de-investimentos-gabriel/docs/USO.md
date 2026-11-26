# Uso — Calculadora de Investimentos Gabriel

> Documentação mínima de uso para o Gabriel (plano macro #6, subtarefa 2 de
> 9 — REQ-NF-001/002/003/005). Toda descrição neste arquivo foi derivada do
> código vigente na data: `config.ts`, `screens/CalculadoraScreen.tsx`,
> `screens/GraficoEvolucao.tsx`, `cotacoes/resolverCotacoes.ts` e
> `docs/DECISOES-COTACOES.md`.

## 1. Como acessar

A aplicação roda no servidor **ServerIA** (stack blue-green; na data desta
escrita o stack **blue** está ativo, conferido via `docker ps`:
`biblioteca-blue-web-1` porta 5174, `biblioteca-blue-api-1` porta 3003).

| Onde você está | URL |
| --- | --- |
| Desktop do próprio ServerIA | `http://localhost:5174` |
| Outro computador da mesma rede (Wi-Fi/ethernet da casa) | `http://192.168.1.11:5174` |
| Celular no Wi-Fi da casa | `http://192.168.1.11:5174` |

O layout é responsivo: no celular a tela da Calculadora usa coluna única,
campos em largura total e botões de toque com altura mínima confortável —
nada precisa ser "modo desktop".

> Obs.: o IP `192.168.1.11` é atribuído por DHCP; se um dia a rede mudar e
> o servidor pegar outro IP, basta conferir no roteador. A porta 5174
> permanece.

## 2. Fluxo: login → projeto → Calculadora

1. Na URL acima abre a tela de **login** da plataforma. Entre com as
   credenciais fornecidas (usuário do sistema — uso exclusivo do Gabriel).
2. Após o login aparece a **seleção de projeto**. Escolha
   **"Calculadora de Investimentos Gabriel"**.
3. O sistema é montado automaticamente com o menu **Investimentos** e duas
   telas:
   - **Índices** — cadastro (listar/criar/editar/excluir) dos índices de
     mercado usados na Calculadora; cada um tem nome, sigla, taxa anual
     vigente, fonte da cotação e ordem. A taxa mensal é sempre derivada da
     anual — não se edita taxa mensal.
   - **Calculadora** — a tela de simulação (seção 3).

Os índices disponíveis no seletor da Calculadora são lidos desse cadastro
(ordem definida pelo campo "Ordem"). Se um índice precisar de atualização de
taxa, é na tela **Índices** que se edita.

## 3. Usando a Calculadora

A tela tem um formulário e, abaixo dele, o resultado. **Tudo é recalculado
automaticamente a cada mudança — não há botão "Calcular"**. E **nada é
salvo**: a simulação é exibida e descartada (fora de escopo por
especificação; seção 5).

Formulário:

| Campo | O que é |
| --- | --- |
| **Tipo de aporte** | Botões **Depósito único** × **Aportes mensais**. Muda o campo de valor entre "Valor do depósito único (R$)" e "Aporte mensal (R$)". |
| **Valor (R$)** | O valor do aporte no modo escolhido (aceita vírgula decimal). |
| **Índice** | Seletor com os índices cadastrados + a opção "Nenhum (use taxa manual)". |
| **Taxa manual (% ao ano)** | Campo livre (seção 3.3). |
| **Prazo (anos)** | Inteiro ≥ 1. |

O resultado mostra a **taxa mensal** efetiva (com a origem dela), o
**valor final projetado** em R$ e o gráfico de evolução (seção 4).

### 3.1 Fluxo 1 — índice com taxa automática (CDI, Selic, IPCA)

1. Escolha o índice no seletor (CDI, SELIC ou IPCA).
2. A tela consulta a **API pública do Banco Central (SGS)** — chamada
   direto do navegador — e exibe, na taxa mensal, a taxa da cotação com a
   data/hora da captura (ex.: "Índice SELIC — cotação SGS em …").
3. Cada fonte devolve uma taxa **anual** e o sistema converte para **mensal
   por juros compostos** (`((1 + taxaAnual/100)^(1/12) − 1) × 100`); a taxa
   exibida e usada no cálculo é sempre a mensal. (CDI: a série do BCB é
   % ao dia e é anualizada em 252 dias úteis antes da conversão.)

Enquanto a consulta está em andamento aparece "Consultando cotação do
índice…".

### 3.2 Fluxo 1b — Ibovespa (variação histórica)

Para o **IBOV**, a "taxa" não vem pronta: o sistema baixa a série de
**nível** do índice no BCB/SGS (últimos ~12 meses de fechamentos) e calcula
a **variação histórica** — `taxa anual = (último valor / valor de 12 meses
atrás − 1) × 100` — que é depois convertida para a mensal, como no fluxo 1.
Ou seja: o Ibovespa entra na simulação pelo quanto o índice subiu (ou caiu)
no último ano, como taxa de crescimento do investimento.

### 3.3 Fluxo 2 — taxa manual (campo livre)

1. Deixe o seletor em **"Nenhum (use taxa manual)"** (ou selecione um
   índice, se preferir) e preencha **"Taxa manual (% ao ano)"**.
2. A taxa manual, **preenchida, tem prioridade sobre a cotação do índice** —
   nenhuma busca é disparada enquanto ela é válida.
3. É o caminho para simular qualquer taxa/índice não cadastrado (ex.: um
   fundo, um título, uma meta própria). Informe em % **ao ano**; o sistema
   converte para a mensal automaticamente.

### 3.4 Quando a cotação falha (fallback e erros)

- Se o BCB/SGS estiver indisponível, demorar ou não devolver dados, a tela
  mostra um aviso amigável ("A fonte de cotação está indisponível no
  momento.", etc.).
- Se o índice cadastrado tiver **taxa anual vigente > 0** na tela
  **Índices**, o sistema usa essa taxa como **fallback** (aviso azul
  "Cotação indisponível no momento — usando a taxa do cadastro do índice")
  e a simulação segue funcionando.
- Com taxa manual preenchida, a simulação funciona mesmo com a cotação
  falhando — ela sobrepõe tudo.
- A cotação de sucesso fica em cache na memória por **10 minutos**: simulações
  seguidas nesse intervalo não voltam a consultar o BCB.

## 4. Gráfico de evolução (ano a ano × mês a mês)

Abaixo do valor final, quando há uma simulação válida, aparece o painel
"**Evolução do investimento**" com o gráfico do saldo ao longo do prazo.

- Use os botões **"Ano a ano"** / **"Mês a mês"** para alternar a visão.
  A alternância **não recalcula nada** — apenas troca a série exibida
  (ponto por ano × ponto por mês do mesmo cálculo).
- O eixo Y é em R$; passando o mouse sobre um ponto aparece o período e o
  saldo daquele ponto ("Ano 2 — R$ …" / "Mês 7 — R$ …").

## 5. Limitações (honestas)

- **Sem histórico de simulações**: nada do que você simula é persistido —
  fechar a aba descarta tudo. É assim por especificação ("cálculo
  descartável").
- **Cotação depende de API pública** (Banco Central/SGS), sujeita a
  indisponibilidade e à qualidade dos dados publicados; o fallback é a taxa
  do cadastro do índice (sem taxa manual, a simulação fica aguardando).
  Detalhes técnicos em `DECISOES-COTACOES.md`.
- **Projeção, não recomendação**: o cálculo é juros compostos sobre a taxa
  informada; não considera imposto, tributação progressiva, variação de
  taxas ao longo do prazo nem taxa de administração.
- Acesso pessoal: as credenciais de login dão acesso a todo o sistema —
  não compartilhe.

## 6. Problemas rápidos

| Sintoma | O que fazer |
| --- | --- |
| Página não abre no celular | Confira se o celular está no mesmo Wi-Fi da rede da casa e digite `http://192.168.1.11:5174` (com `http`, não `https`). |
| "A fonte de cotação está indisponível no momento" | Espere e tente de novo; ou preencha a taxa manual; o fallback do cadastro do índice, se existir, já mantém a simulação funcionando. |
| Índice não aparece no seletor | Cadastre/revise na tela **Investimentos → Índices** (a tela da Calculadora lê esse cadastro). |
| Resultado "—" | Confira valor ≥ 0, prazo inteiro ≥ 1 e uma taxa (índice ou manual). |
