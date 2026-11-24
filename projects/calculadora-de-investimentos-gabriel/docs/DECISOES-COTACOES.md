# Decisões — Integração de cotações (SGS vs BrasilAPI)

> Plano macro #6 — Calculadora de Investimentos Gabriel, posição 2/9
> (subtarefa 1: resolvedor de cotações). Registrado em 2026-11-23 pela DEV.
> Módulo: `cotacoes/resolverCotacoes.ts`.

## 1. Fonte primária: BCB/SGS para todos os índices

Escolha: **SGS (`api.bcb.gov.br`) como fonte primária para CDI, Selic, IPCA
e Ibovespa**; BrasilAPI fica **documentada como alternativa por índice** no
mapeamento (`alternativaBrasilApi`), mas **não é chamada** por esta versão.

Justificativa:

- O requisito (RF-3, ESPECIFICACAO.md) nomeia explicitamente o Banco Central
  (SGS) como fonte; SGS cobre os quatro índices numa única API com formato
  estável e sem autenticação.
- Verificação **ao vivo em 2026-11-23** (via
  `https://api.bcb.gov.br/dados/serie/bcdata.sgs.<serie>/dados/ultimos/N?formato=json`):
  as chamadas usadas pelo módulo respondem 200 com JSON `[{data,valor}]`.
- BrasilAPI foi testada no mesmo dia e parte dos endpoints esperados
  (`/api/selic`, `/api/ibovespa`) respondeu **404** no momento da verificação
  — não é alternativa confiável para substituir SGS sem nova pesquisa.
- Manter uma única fonte simplifica o cliente e o tratamento de erro; a
  alternativa por índice fica registrada para ativação futura (decisão da
  equipe técnica, conforme ESPECIFICACAO.md "fonte alternativa em avaliação").

## 2. Códigos de série verificados (2026-11-23)

A macro listou candidatos "usuais" e proibiu assumi-los de memória. Evidência
de cada chamada (respostas reais do dia da verificação):

| Sigla  | Série SGS | Conteúdo verificado                                                                                                   | Resposta observada (ex.)                                  |
| ------ | --------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| CDI    | **12**    | Taxa CDI **% ao dia** ("d.i."), diária                                                                                | `{"data":"19/11/2026","valor":"0.050788"}`                 |
| SELIC  | **4389**  | **Selic acumulada em doze meses — % a.a.** (diária) — taxa anual direta                                               | `{"data":"19/11/2026","valor":"13.65"}`                    |
| IPCA   | **13522** | **IPCA acumulado em doze meses — % a.a.** (mensal) — taxa anual direta                                                | `{"data":"01/10/2026","valor":"4.63"}`                     |
| IBOV   | **33**    | **Ibovespa – fechamento (nível, pontos)**, diária com dados recentes                                                  | `{"data":"13/11/2026","valor":"27459193"}`                  |

Correções importantes aos candidatos da macro:

- **4389 não é IPCA nem Ibovespa** — é a *Selic acumulada em 12 meses*
  (% a.a.). Ela é a fonte da taxa anual da **Selic** (a candidata 11 devolve
  taxa **% a.d.**, não anual).
- **IPCA**: 433 é a variação **mensal** (% m/m), não anual; 13522 é o
  **acumulado em 12 meses (% a.a.)** — exatamente o que o requisito pede
  como "taxa anual da fonte" para inflação.
- **Ibovespa**: a macro citou 4389, que é Selic. A série de **nível** com
  dados recentes é **33** (verificada com pontos de nov/2026). Candidatas
  testadas e descartadas: 22, 415, 1314, 2771, 4421, 4423, 4339 (séries de
  nível que pararam de atualizar entre 2012 e 2019), 454/482 ("Requisição
  inválida" no endpoint bcdata), 1313 (retorna 200 mas estaciona em 2004).
  Também foram descartadas 2234/4390 (valores implausíveis para Ibovespa).

Alternativas BrasilAPI documentadas por índice (não usadas):
CDI `/api/cdi/v1/cdi`; Selic `/api/selic/v1`; IPCA `/api/ipca/v1`;
Ibovespa `/api/ibovespa-historico` (testada em 2026-11-23: 404 nos endpoints
`/api/selic` e `/api/ibovespa` — manter SGS).

## 3. Critérios de conversão por tipo de série

- **Taxa anual direta** (Selic 4389, IPCA 13522): último valor da série é a
  taxa anual em % a.a.; usado sem transformação.
- **% ao dia** (CDI 12): anualização por juros compostos em 252 dias úteis —
  `anual = ((1 + di/100)^252 − 1) × 100` (convenção padrão do mercado para
  CDI d.i.). Exportada como `anualizarTaxaDi`.
- **Anual → mensal** (REQ-F-006): função pura exportada
  `converterAnualParaMensal(anual) = ((1 + anual/100)^(1/12) − 1) × 100`
  (entrada/saída em %; apenas a mensal alimenta a projeção, e nada de taxa
  mensal é persistido).

## 4. Critério de variação histórica (Ibovespa, `usaVariacaoHistorica=true`)

RF-5: para o Ibovespa a taxa de crescimento é a **variação histórica do
índice**. Critério implementado e testado:

```
taxaAnual = (ultimoValor / valorHa12Meses − 1) × 100
```

- `ultimoValor`: último observador da série de nível (série 33, diária).
- `valorHa12Meses`: o **último observador com data ≤ 12 meses antes da data
  do último ponto** (calendário: mesma regra `Date` retrocedendo 12 meses).
  Se a série não cobre a janela → `CotacaoError DADO_AUSENTE` (ou fallback).
- O módulo baixa até 320 observações (`ultimos/320`), o que cobre ≥ 12 meses
  de pontos diários com folga; o critério funciona igualmente para séries
  mensais (fixture dos testes usa série mensal).
- A mesma fórmula serve para qualquer índice com
  `usaVariacaoHistorica=true` (o flag pode ser forçado pelo chamador em
  `IndiceCotavel.usaVariacaoHistorica`).

## 5. Falha, timeout e fallback (REQ-NF-003)

- Timeout por chamada via `AbortController` (`timeoutMs`, default 8s) →
  `CotacaoError { code: "TIMEOUT" }`.
- HTTP ≠ 2xx, corpo não-JSON ou erro de rede → `FONTE_INDISPONIVEL`; série
  sem observações/janela insuficiente → `DADO_AUSENTE`.
- **Nenhum erro cru escapa**: `resolverCotacao` devolve sempre a união
  discriminada `{ ok: true, cotacao } | { ok: false, error: CotacaoError }`.
- `taxaAnualFallback` informado → cotação construída com a taxa do chamador
  e `fonte` prefixada com `fallback (<code>: <motivo>)`; **valores de
  fallback nunca entram no cache** (a próxima chamada tenta a fonte de novo).

## 6. Cache (REQ-NF-003)

Memória, por sigla, TTL configurável **default 10 min**
(`TTL_CACHE_COTACOES_MS`), relógio injetável (`opcoes.agora`) — a 2ª chamada
dentro da janela não invoca `fetch`. `limparCacheCotacoes()` força renovação.

## 7. Onde o módulo roda (CORS)

O resolvedor é **server-side (Node 22, `fetch` global, zero dependência
nova)**. A UI (GeradorSistema/apps/web) **não chama este módulo
diretamente** — ela só o alcançará via `packages/api-client` em subtarefa de
UI própria, atrás de um endpoint da API. O **proxy condicional de CORS da
macro NÃO é acionado nesta posição do plano**: nenhuma chamada de browser é
adicionada aqui, portanto não há restrição de CORS a contornar por enquanto.
Se a subtarefa de UI evoluir para chamada direta do browser, a política de
CORS da SGS deverá ser reavaliada e o proxy mínimo no backend, se necessário,
será decidido nela.
