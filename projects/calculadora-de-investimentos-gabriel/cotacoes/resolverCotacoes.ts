/**
 * Resolvedor de cotações do projeto `calculadora-de-investimentos-gabriel`
 * (plano macro #6, posição 2/9 — REQ-F-003/REQ-F-005/REQ-F-006, REQ-I-001,
 * REQ-D-003, REQ-NF-003).
 *
 * Para cada índice selecionável (CDI, Selic, IPCA, Ibovespa) busca a taxa
 * atual na fonte pública BCB/SGS, trata o caso `usaVariacaoHistorica`
 * (Ibovespa: variação anualizada sobre a série de nível dos últimos 12
 * meses) e converte anual→mensal por juros compostos (RF-6).
 *
 * Contratos:
 * - `resolverCotacao(indice, opcoes)` NUNCA lança erro cru: o resultado é a
 *   união discriminada `ResolvedorCotacoesResultado`
 *   (`{ ok: true, cotacao } | { ok: false, error: CotacaoError }`), com
 *   `CotacaoError.code ∈ TIMEOUT | FONTE_INDISPONIVEL | DADO_AUSENTE`.
 * - Fonte com `fetch` e relógio injetáveis (Node 22 tem `fetch` global —
 *   NENHUMA dependência nova).
 * - Cache em memória por índice com TTL configurável (default 10 min);
 *   valores de fallback NUNCA entram no cache.
 * - Falha da fonte → `taxaAnualFallback` do chamador (com `fonte` marcada
 *   como fallback) ou `CotacaoError` tipado quando não houver fallback.
 *
 * Decisão de fonte (SGS vs BrasilAPI por índice), códigos de série
 * verificados ao vivo em 2026-11-23 e critérios documentados em
 * `docs/DECISOES-COTACOES.md`. O módulo roda em Node; a UI só o alcançará
 * via `packages/api-client` em subtarefa própria (nenhuma chamada de
 * browser é adicionada aqui — o proxy condicional de CORS não é acionado).
 */

// ============================================================================
// Tipos públicos
// ============================================================================

/** Códigos de erro tipados do resolvedor (nenhum erro cru escapa da API). */
export type CodigoCotacaoError = "TIMEOUT" | "FONTE_INDISPONIVEL" | "DADO_AUSENTE"

/** Erro tipado e tratável pelo chamador. */
export interface CotacaoError {
  readonly code: CodigoCotacaoError
  readonly mensagem: string
  /** Série/fonte envolvida, quando conhecida (diagnóstico). */
  readonly origem?: string
  /**
   * `true` quando a falha é transitória (TIMEOUT / rede / HTTP 5xx) e uma
   * nova tentativa pode ter sucesso; omitido/`false` = erro de negócio
   * (4xx, parse, DADO_AUSENTE), que NÃO deve ser retentado. Define se o
   * retry único é acionado.
   */
  readonly transitoria?: boolean
}

/** Cotação resolvida com sucesso (shape exigido pelo plano, posição 2/9). */
export interface Cotacao {
  readonly sigla: string
  /** Taxa anual em % a.a. (ex.: 13.65 = 13,65% ao ano). */
  readonly taxaAnual: number
  /**
   * Taxa mensal derivada por juros compostos, em % a.m.:
   * `((1 + taxaAnual/100)^(1/12) − 1) × 100` (REQ-F-006; apenas a mensal
   * alimenta a projeção, e nunca é persistida).
   */
  readonly taxaMensal: number
  /** Origem da cotação; valores de fallback carregam o prefixo "fallback". */
  readonly fonte: string
  /** Momento da captura (ISO-8601, relógio injetável). */
  readonly capturadaEm: string
}

export type ResolvedorCotacoesResultado =
  | { readonly ok: true; readonly cotacao: Cotacao; readonly tentativas: number }
  | { readonly ok: false; readonly error: CotacaoError; readonly tentativas: number }

/** Índice sob resolução (projeção do cadastro `indices` + opções da macro). */
export interface IndiceCotavel {
  /** Sigla do índice — chave do mapeamento `MAPEAMENTO_COTACOES` (CDI, SELIC, IPCA, IBOV). */
  readonly sigla: string
  /**
   * Override do critério de variação histórica (RF-5). Quando omitido,
   * vale o flag do mapeamento da série (Ibovespa: `true`).
   */
  readonly usaVariacaoHistorica?: boolean
  /** Taxa anual (% a.a.) a usar quando a fonte falhar (fallback do chamador). */
  readonly taxaAnualFallback?: number | null
}

/** Assinatura mínima de fetch usada pelo módulo (compatível com o global do Node 22). */
export type FetchDeCotacao = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** Dependências injetáveis de `resolverCotacao` (todas opcionais). */
export interface ResolutorOpcoes {
  /** Implementação de fetch (default: `globalThis.fetch`). Injetada nos testes. */
  readonly fetchFn?: FetchDeCotacao
  /** Relógio em epoch-ms (default: `Date.now`). Injetável para o teste de cache. */
  readonly agora?: () => number
  /** TTL do cache em ms (default 10 min). */
  readonly ttlMs?: number
  /** Timeout por chamada de fonte em ms (default 8s; AbortController). */
  readonly timeoutMs?: number
}

// ============================================================================
// Mapeamento codigoFonte→série (códigos verificados ao vivo — DECISOES-COTACOES.md)
// ============================================================================

/** Como interpretar o último valor da série. */
export type TipoValorSerie =
  /** Taxa anual direta em % a.a. (ex.: Selic acumulada 12m = 13,65). */
  | "TAXA_ANUAL"
  /** Taxa % ao DIA (CDI di) — anualizada por juros compostos em 252 dias úteis. */
  | "TAXA_DI"
  /** Nível do índice (Ibovespa) — exige critério de variação histórica. */
  | "NIVEL"

/** Entrada do mapeamento codigoFonte→série SGS, com alternativa BrasilAPI documentada. */
export interface MapeamentoSerieSgs {
  readonly fonte: "SGS"
  /** Identificador numérico da série SGS (verificado ao vivo, 2026-11-23). */
  readonly serie: string
  readonly descricao: string
  readonly tipoValor: TipoValorSerie
  /** true → taxa anual = variação do nível nos últimos 12 meses (RF-5). */
  readonly usaVariacaoHistorica: boolean
  /** Alternativa documentada (BrasilAPI); NÃO é chamada por este módulo — ver DECISOES-COTACOES.md. */
  readonly alternativaBrasilApi: string
}

/** CDI/Selic em % d.i. anualizam-se em 252 dias úteis (convenção do mercado). */
export const DIAS_UTEIS_POR_ANO = 252

/**
 * Mapeamento sigla→série SGS. Códigos conferidos ao vivo em 2026-11-23 via
 * `https://api.bcb.gov.br/dados/serie/bcdata.sgs.<serie>/dados/ultimos/2?formato=json`
 * (evidências em docs/DECISOES-COTACOES.md). NÃO assumir de memória:
 * Ibovespa é a série de NÍVEL 33 (fechamento diário, dados recentes), e a
 * "candidata 4389" da macro é, na verdade, Selic acumulada em 12 meses.
 */
export const MAPEAMENTO_COTACOES: Readonly<Record<string, MapeamentoSerieSgs>> = {
  CDI: {
    fonte: "SGS",
    serie: "12",
    descricao: "CDI - Taxa - % ao dia (d.i.) — anualizada em 252 dias úteis",
    tipoValor: "TAXA_DI",
    usaVariacaoHistorica: false,
    alternativaBrasilApi: "https://brasilapi.com.br/api/cdi/v1/cdi (documentada; não usada — ver DECISOES-COTACOES.md)",
  },
  SELIC: {
    fonte: "SGS",
    serie: "4389",
    descricao: "Selic acumulada em doze meses (% a.a.) — taxa anual direta da fonte",
    tipoValor: "TAXA_ANUAL",
    usaVariacaoHistorica: false,
    alternativaBrasilApi: "https://brasilapi.com.br/api/selic/v1 (documentada; não usada — ver DECISOES-COTACOES.md)",
  },
  IPCA: {
    fonte: "SGS",
    serie: "13522",
    descricao: "IPCA acumulado em doze meses (% a.a., mensal) — taxa anual direta da fonte",
    tipoValor: "TAXA_ANUAL",
    usaVariacaoHistorica: false,
    alternativaBrasilApi: "https://brasilapi.com.br/api/ipca/v1 (documentada; não usada — ver DECISOES-COTACOES.md)",
  },
  IBOV: {
    fonte: "SGS",
    serie: "33",
    descricao: "Ibovespa - Fechamento (pontos, diário) — variação histórica anualizada de 12 meses (RF-5)",
    tipoValor: "NIVEL",
    usaVariacaoHistorica: true,
    alternativaBrasilApi: "https://brasilapi.com.br/api/ibovespa-historico (documentada; não usada — ver DECISOES-COTACOES.md)",
  },
}

// ============================================================================
// Funções puras exportadas (conversões e critérios)
// ============================================================================

/**
 * Conversão anual→mensal por juros compostos (REQ-F-006, critério da
 * subtarefa): entra % a.a., sai % a.m.
 * `(1 + anual/100)^(1/12) − 1` expresso em % → `((1 + anual/100)^(1/12) − 1) × 100`.
 */
export function converterAnualParaMensal(taxaAnualPorcentagem: number): number {
  return (Math.pow(1 + taxaAnualPorcentagem / 100, 1 / 12) - 1) * 100
}

/**
 * Anualização de taxa % ao dia (CDI/Selic d.i.): juros compostos em 252
 * dias úteis — `((1 + di/100)^252 − 1) × 100` (convenção do mercado,
 * documentada em DECISOES-COTACOES.md).
 */
export function anualizarTaxaDi(taxaDiPorcentagem: number, diasUteis = DIAS_UTEIS_POR_ANO): number {
  return (Math.pow(1 + taxaDiPorcentagem / 100, diasUteis) - 1) * 100
}

/**
 * Variação histórica anualizada de um nível (RF-5 — Ibovespa):
 * `(ultimo/anterior12m − 1) × 100`, onde `anterior12m` é o último
 * observado até 12 meses antes da data do último ponto (critério completo
 * documentado em docs/DECISOES-COTACOES.md §4).
 */
export function calcularVariacaoHistorica(
  ultimoValor: number,
  valorHa12Meses: number,
): number {
  return (ultimoValor / valorHa12Meses - 1) * 100
}

// ============================================================================
// Cliente SGS (fonte primária)
// ============================================================================

/** URL pública da série SGS no formato JSON (mesmo padrão verificado ao vivo). */
export function urlSerieSgs(serie: string, quantidade: number): string {
  return `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados/ultimos/${quantidade}?formato=json`
}

interface ObservacaoSgs {
  readonly dataMs: number
  readonly valor: number
}

/** Parsing tolerante de número SGS ("13.65" ou "13,65"). */
function parsearNumero(texto: unknown): number | null {
  if (typeof texto === "number") return Number.isFinite(texto) ? texto : null
  if (typeof texto !== "string") return null
  const n = Number(texto.trim().replace(",", "."))
  return Number.isFinite(n) ? n : null
}

/** Parsing de data SGS `dd/mm/aaaa` (sem dependência de Intl/locale). */
function parsearDataSgs(texto: unknown): number | null {
  if (typeof texto !== "string") return null
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto.trim())
  if (!m) return null
  const [, dia, mes, ano] = m
  const ms = Date.UTC(Number(ano), Number(mes) - 1, Number(dia))
  return Number.isFinite(ms) ? ms : null
}

/** Converte o corpo JSON da SGS em observações ordenadas por data (asc). */
function parsearObservacoesSgs(corpo: unknown): ObservacaoSgs[] {
  if (!Array.isArray(corpo)) return []
  const observacoes: ObservacaoSgs[] = []
  for (const item of corpo) {
    if (typeof item !== "object" || item === null) continue
    const dataMs = parsearDataSgs((item as { data?: unknown }).data)
    const valor = parsearNumero((item as { valor?: unknown }).valor)
    if (dataMs === null || valor === null) continue
    observacoes.push({ dataMs, valor })
  }
  return observacoes.sort((a, b) => a.dataMs - b.dataMs)
}

function novoErro(
  code: CodigoCotacaoError,
  mensagem: string,
  origem?: string,
  transitoria = false,
): CotacaoError {
  return Object.freeze({
    code,
    mensagem,
    ...(origem ? { origem } : {}),
    ...(transitoria ? { transitoria: true } : {}),
  })
}

/**
 * GET JSON com timeout por AbortController. Erros de rede/HTTP/parse viram
 * `CotacaoError` — abort por tempo vira `TIMEOUT`.
 */
async function buscarJsonComTimeout(
  url: string,
  fetchFn: FetchDeCotacao,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resposta = await fetchFn(url, { signal: controller.signal })
    if (!resposta.ok) {
      // 5xx é transitório (elegível a retry); 4xx é erro de negócio (sem retry).
      throw novoErro(
        "FONTE_INDISPONIVEL",
        `fonte respondeu HTTP ${resposta.status}`,
        url,
        resposta.status >= 500,
      )
    }
    const texto = await resposta.text()
    try {
      return JSON.parse(texto) as unknown
    } catch {
      // Corpo inválido = erro de negócio (parse), não transitório.
      throw novoErro("FONTE_INDISPONIVEL", "corpo da fonte não é JSON válido", url, false)
    }
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error) throw error
    const name = (error as { name?: string } | null)?.name
    if (name === "AbortError") {
      throw novoErro("TIMEOUT", `fonte não respondeu em ${timeoutMs}ms`, url, true)
    }
    // Falha de rede = transitória (elegível a retry).
    throw novoErro(
      "FONTE_INDISPONIVEL",
      `falha de rede ao consultar a fonte: ${(error as Error)?.message ?? "erro desconhecido"}`,
      url,
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Observações da série SGS ordenadas por data (asc); vazio quando sem dados. */
async function observarSerieSgs(
  serie: string,
  quantidade: number,
  fetchFn: FetchDeCotacao,
  timeoutMs: number,
): Promise<ObservacaoSgs[]> {
  const corpo = await buscarJsonComTimeout(urlSerieSgs(serie, quantidade), fetchFn, timeoutMs)
  return parsearObservacoesSgs(corpo)
}

// ============================================================================
// Critério de variação histórica (Ibovespa)
// ============================================================================

/**
 * Janela mínima de observações de nível para cobrir 12 meses de pontos
 * diários com folga (≈252 úteis + margem). Série mensal funciona com menos.
 */
const QUANTIDADE_OBSERVACOES_NIVEL = 320

/** Data-msec exatamente 12 meses antes de `ms` (calendário; dia preserva quando possível). */
function dezMesesAntes(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())
}

/**
 * Último observado até 12 meses antes do último ponto. Retorna null quando a
 * série não cobre a janela.
 */
function selecionarValorHa12Meses(
  observacoes: readonly ObservacaoSgs[],
): ObservacaoSgs | null {
  if (observacoes.length === 0) return null
  const ultimo = observacoes[observacoes.length - 1]
  if (!ultimo) return null
  const limite = dezMesesAntes(ultimo.dataMs)
  let candidata: ObservacaoSgs | null = null
  for (const obs of observacoes) {
    if (obs.dataMs <= limite) candidata = obs
    else break
  }
  return candidata
}

// ============================================================================
// Cache em memória (TTL default 10 min, relógio injetável)
// ============================================================================

interface EntradaCache {
  readonly cotacao: Cotacao
  readonly armazenadoEmMs: number
}

/** Cache por sigla. Fallbacks NUNCA são armazenados (fonte deve ser tentada de novo). */
const cacheCotacoes = new Map<string, EntradaCache>()

/** Limpa o cache em memória (uso em testes e renovação forçada). */
export function limparCacheCotacoes(): void {
  cacheCotacoes.clear()
}

/** TTL padrão da janela de cache: 10 minutos (REQ-NF-003). */
export const TTL_CACHE_COTACOES_MS = 10 * 60 * 1000

/** Timeout padrão por chamada de fonte. */
export const TIMEOUT_FONTE_MS = 8000

// ============================================================================
// API pública: resolverCotacao
// ============================================================================

/** Monta a cotação de sucesso a partir da taxa anual (% a.a.) resolvida. */
function montarCotacao(
  sigla: string,
  taxaAnual: number,
  fonte: string,
  agoraMs: number,
): Cotacao {
  return Object.freeze({
    sigla,
    taxaAnual,
    taxaMensal: converterAnualParaMensal(taxaAnual),
    fonte,
    capturadaEm: new Date(agoraMs).toISOString(),
  })
}

/**
 * Resolve a cotação de um índice. NUNCA lança: devolve
 * `{ ok: true, cotacao, tentativas }` ou `{ ok: false, error, tentativas }`.
 *
 * Fluxo: cache (TTL) → série SGS do mapeamento (com retry único para falhas
 * transitórias: TIMEOUT/rede/5xx, AbortController próprio por tentativa,
 * `tentativas` contado) → critério por tipo de valor (taxa anual direta /
 * % d.i. anualizada / variação histórica 12m) → cache → retorno. Em falha
 * (após esgotar o retry ou erro de negócio): fallback do chamador (não
 * cacheado) ou erro tipado.
 *
 * `tentativas`: 0 em cache hit, 1 em acerto/falha sem retry na 1ª tentativa,
 * 2 quando houve o retry único. `error.transitoria` indica se a causa é
 * recuperável (retry).
 */
export async function resolverCotacao(
  indice: IndiceCotavel,
  opcoes: ResolutorOpcoes = {},
): Promise<ResolvedorCotacoesResultado> {
  const agora = opcoes.agora ?? Date.now
  const ttlMs = opcoes.ttlMs ?? TTL_CACHE_COTACOES_MS
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_FONTE_MS
  const fetchFn = opcoes.fetchFn ?? ((globalThis as { fetch: FetchDeCotacao }).fetch)

  const agoraMs = agora()
  const emCache = cacheCotacoes.get(indice.sigla)
  if (emCache && agoraMs - emCache.armazenadoEmMs < ttlMs) {
    return { ok: true, cotacao: emCache.cotacao, tentativas: 0 }
  }

  const mapeamento = MAPEAMENTO_COTACOES[indice.sigla]
  const usaVariacaoHistorica =
    indice.usaVariacaoHistorica ?? mapeamento?.usaVariacaoHistorica ?? false

  // Retry único: 1 tentativa inicial + 1 nova tentativa (AbortController
  // próprio por tentativa, mesmo `timeoutMs`) apenas para falhas
  // transitórias. Erros de negócio (4xx/parse/DADO_AUSENTE) NÃO geram
  // retry. O tempo total nunca excede 2 × timeoutMs. `tentativas` é exposto
  // no resultado (0 em cache hit).
  const MAX_TENTATIVAS = 2
  let tentativas = 0
  let ultimoErro: CotacaoError | null = null

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    tentativas++
    try {
      const cotacao = await tentarFonte(
        indice.sigla,
        mapeamento,
        usaVariacaoHistorica,
        fetchFn,
        timeoutMs,
        agoraMs,
      )
      // Sucesso na fonte: armazena em cache (fallback NUNCA é cacheado).
      cacheCotacoes.set(indice.sigla, { cotacao, armazenadoEmMs: agoraMs })
      return { ok: true, cotacao, tentativas }
    } catch (error: unknown) {
      const cotacaoError: CotacaoError =
        error && typeof error === "object" && "code" in error
          ? (error as CotacaoError)
          : novoErro(
              "FONTE_INDISPONIVEL",
              `falha inesperada ao resolver cotação: ${(error as Error)?.message ?? "erro desconhecido"}`,
              indice.sigla,
            )
      ultimoErro = cotacaoError
      // Continua (retry) só para falha transitória com tentativa restante.
      if (cotacaoError.transitoria === true && tentativa + 1 < MAX_TENTATIVAS) continue
      break
    }
  }

  // Esgotou o retry (ou erro não-transitório): fallback do chamador
  // (NUNCA cacheado) ou erro tipado.
  const cotacaoError =
    ultimoErro ??
    novoErro("FONTE_INDISPONIVEL", "falha ao resolver cotação", indice.sigla)
  const fallback = indice.taxaAnualFallback
  if (fallback !== null && fallback !== undefined && Number.isFinite(fallback)) {
    return {
      ok: true,
      cotacao: montarCotacao(
        indice.sigla,
        fallback,
        `fallback (${cotacaoError.code}: ${cotacaoError.mensagem})`,
        agoraMs,
      ),
      tentativas,
    }
  }
  return { ok: false, error: cotacaoError, tentativas }
}

/**
 * Uma tentativa completa de resolução na fonte (SGS): busca a série, aplica
 * o critério por tipo de valor (taxa anual direta / % d.i. anualizada /
 * variação histórica 12m) e monta a cotação. Lança `CotacaoError` — a
 * classificação transitória/não-transitória (`transitoria`) define se o
 * chamador deve retentar. Não lida com cache nem fallback (responsabilidade
 * de `resolverCotacao`).
 */
async function tentarFonte(
  sigla: string,
  mapeamento: MapeamentoSerieSgs | undefined,
  usaVariacaoHistorica: boolean,
  fetchFn: FetchDeCotacao,
  timeoutMs: number,
  agoraMs: number,
): Promise<Cotacao> {
  if (!mapeamento) {
    throw novoErro(
      "DADO_AUSENTE",
      `sigla '${sigla}' sem mapeamento de série SGS`,
      sigla,
    )
  }

  const origem = `Banco Central (SGS) — série ${mapeamento.serie} (${mapeamento.descricao})`
  const quantidade =
    mapeamento.tipoValor === "NIVEL" || usaVariacaoHistorica
      ? QUANTIDADE_OBSERVACOES_NIVEL
      : 2

  const observacoes = await observarSerieSgs(
    mapeamento.serie,
    quantidade,
    fetchFn,
    timeoutMs,
  )

  if (mapeamento.tipoValor === "NIVEL" || usaVariacaoHistorica) {
    // Critério Ibovespa (RF-5): variação do nível entre o último ponto e o
    // último ponto até 12 meses antes. Documentado em DECISOES-COTACOES.md §4.
    const ultimo = observacoes[observacoes.length - 1]
    const anterior = selecionarValorHa12Meses(observacoes)
    if (!ultimo || !anterior || anterior.valor === 0) {
      throw novoErro(
        "DADO_AUSENTE",
        "série de nível sem dados suficientes para variação de 12 meses",
        origem,
      )
    }
    return montarCotacao(
      sigla,
      calcularVariacaoHistorica(ultimo.valor, anterior.valor),
      origem,
      agoraMs,
    )
  }

  const ultimo = observacoes[observacoes.length - 1]
  if (!ultimo) {
    throw novoErro("DADO_AUSENTE", "série sem observações", origem)
  }
  const taxaAnual =
    mapeamento.tipoValor === "TAXA_DI"
      ? anualizarTaxaDi(ultimo.valor)
      : ultimo.valor
  return montarCotacao(sigla, taxaAnual, origem, agoraMs)
}
