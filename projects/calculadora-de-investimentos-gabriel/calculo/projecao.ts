/**
 * Motor de cálculo financeiro do projeto `calculadora-de-investimentos-gabriel`
 * (plano macro #6, posição 3/9 — REQ-F-002, REQ-F-006, REQ-D-001, REQ-D-002,
 * REQ-NF-003).
 *
 * Módulo 100% puro: sem HTTP, sem persistência, sem efeitos colaterais — a
 * simulação é efêmera (ESPECIFICACAO.md "Fora de escopo": nada de histórico).
 *
 * Convenções (documentadas — exigência da subtarefa):
 * - Aporte ao FIM de cada mês (série/annuidade ORDINÁRIA): o saldo do mês k é
 *   `saldo(k−1) · (1 + i) + pmt`.
 * - `i` nas funções de cálculo é a TAXA MENSAL EM FRAÇÃO DECIMAL
 *   (0.01 = 1% a.m.). A entrada do usuário aceita % (percentual), como na
 *   cotação (`Cotacao.taxaMensal` é % a.m.).
 * - Valor futuro de depósito único: `P · (1 + i)^n`.
 * - Valor futuro de aportes mensais (fórmula fechada da anuidade ordinária):
 *   `PMT · ((1 + i)^n − 1) / i` (para i > 0; `PMT · n` para i = 0).
 * - Conversão anual→mensal (REQ-F-006/RF-6): SEMPRE a função compartilhada
 *   `converterAnualParaMensal` de `../cotacoes/resolverCotacoes.ts` — a
 *   fórmula NÃO é reimplementada aqui.
 *
 * Consistência das séries (REQ-D-002): os pontos são gerados pela recorrência
 * mês a mês; `valorFinal` é o último ponto mensal, e a série anual colhe o
 * ponto de cada mês 12·ano — o último ponto anual coincide com `valorFinal`
 * (prazo em anos inteiros ⇒ 12·prazo meses).
 */

import { converterAnualParaMensal } from "../cotacoes/resolverCotacoes"

// ============================================================================
// Tipos públicos
// ============================================================================

/** Modo de aporte da simulação (RF-2: depósito único ou mensal recorrente). */
export type ModoAporte = "unico" | "mensal"

/**
 * Taxa de entrada em percentual: mensal direta OU anual convertida
 * internamente pela função compartilhada (REQ-F-006). Exatamente uma das
 * duas deve ser informada.
 */
export type TaxaEntradaPercentual =
  | { readonly taxaMensalPercentual: number; readonly taxaAnualPercentual?: never }
  | { readonly taxaAnualPercentual: number; readonly taxaMensalPercentual?: never }

interface SimulacaoBase {
  /** Prazo em anos (inteiro ≥ 1 — entidades ESPECIFICACAO.md: "prazo em anos"). */
  readonly prazoAnos: number
}

/** Depósito único: valor inicial aplicado no mês 0, sem aportes recorrentes. */
export interface SimulacaoUnico extends SimulacaoBase {
  readonly modo: "unico"
  /** Valor do depósito único (moeda; ex.: 1000 = R$ 1.000,00). */
  readonly valorInicial: number
}

/** Aportes mensais recorrentes (série ordinária: aporte ao fim de cada mês). */
export interface SimulacaoMensal extends SimulacaoBase {
  readonly modo: "mensal"
  /** Valor do aporte mensal (moeda), aplicado ao fim de cada mês. */
  readonly aporteMensal: number
}

/** Entrada da projeção: modo de aporte + taxa (% mensal ou % anual) + prazo. */
export type Simulacao = (SimulacaoUnico | SimulacaoMensal) & TaxaEntradaPercentual

/** Ponto de evolução da série (para o gráfico — RF-7). */
export interface PontoSerie {
  /** Número do mês (1-based; mês 1 = primeiro mês decorrido). */
  readonly mes: number
  /** Saldo de referência no fim do mês (rendimento composto acumulado). */
  readonly valor: number
  /** Total investido até o mês (depósito único + aportes já realizados). */
  readonly valorInvestido: number
}

/** Resultado da projeção (entidade ESPECIFICACAO.md: valor final + séries). */
export interface ResultadoProjecao {
  /** Valor final projetado == último ponto mensal == último ponto anual. */
  readonly valorFinal: number
  /** Taxa mensal efetiva usada, em fração decimal (0.01 = 1% a.m.). */
  readonly taxaMensalFracao: number
  /** Série mês a mês com `prazoAnos · 12` pontos (REQ-D-002). */
  readonly pontosMensais: readonly PontoSerie[]
  /** Série ano a ano com `prazoAnos` pontos, colhida da mensal (REQ-D-002). */
  readonly pontosAnuais: readonly PontoSerie[]
}

// ============================================================================
// Validação de entrada
// ============================================================================

/** Rejeita entrada inválida com mensagem clara (nunca calcula garbage). */
function validarSimulacao(simulacao: Simulacao): void {
  const { prazoAnos, modo } = simulacao
  if (!Number.isInteger(prazoAnos) || prazoAnos < 1) {
    throw new RangeError(
      `prazoAnos deve ser inteiro ≥ 1 (recebido: ${String(prazoAnos)})`,
    )
  }
  if (modo === "unico") {
    if (!Number.isFinite(simulacao.valorInicial) || simulacao.valorInicial < 0) {
      throw new RangeError("valorInicial do depósito único deve ser finito e ≥ 0")
    }
  } else {
    if (!Number.isFinite(simulacao.aporteMensal) || simulacao.aporteMensal < 0) {
      throw new RangeError("aporteMensal deve ser finito e ≥ 0")
    }
  }
  const temMensal = simulacao.taxaMensalPercentual !== undefined
  const temAnual = simulacao.taxaAnualPercentual !== undefined
  if (temMensal === temAnual) {
    throw new RangeError(
      "informe exatamente uma taxa: taxaMensalPercentual OU taxaAnualPercentual",
    )
  }
  const taxa = temMensal ? simulacao.taxaMensalPercentual : simulacao.taxaAnualPercentual
  if (typeof taxa !== "number" || !Number.isFinite(taxa) || taxa < 0) {
    throw new RangeError("taxa em percentual deve ser finita e ≥ 0")
  }
}

/**
 * Resolve a taxa mensal em fração decimal a partir da entrada em percentual.
 * Taxa anual passa OBRIGATORIAMENTE pela conversão compartilhada
 * `converterAnualParaMensal` (REQ-F-006 — fórmula não duplicada).
 */
export function taxaMensalEmFracao(
  simulacao: Pick<Simulacao, "taxaMensalPercentual" | "taxaAnualPercentual">,
): number {
  if (simulacao.taxaMensalPercentual !== undefined) {
    return simulacao.taxaMensalPercentual / 100
  }
  const anual = simulacao.taxaAnualPercentual
  if (anual === undefined) {
    throw new RangeError(
      "informe exatamente uma taxa: taxaMensalPercentual OU taxaAnualPercentual",
    )
  }
  return converterAnualParaMensal(anual) / 100
}

// ============================================================================
// Funções puras de valor futuro
// ============================================================================

/**
 * Valor futuro de depósito único (juros compostos): `P · (1 + i)^n`.
 * @param valorPrincipal P em moeda
 * @param taxaMensalFracao i em fração decimal (0.01 = 1% a.m.)
 * @param prazoMeses n em meses (inteiro ≥ 0)
 */
export function valorFuturoDepositoUnico(
  valorPrincipal: number,
  taxaMensalFracao: number,
  prazoMeses: number,
): number {
  return valorPrincipal * Math.pow(1 + taxaMensalFracao, prazoMeses)
}

/**
 * Valor futuro de aportes mensais recorrentes — anuidade ORDINÁRIA
 * (aporte ao fim de cada mês): `PMT · ((1 + i)^n − 1) / i`, e `PMT · n`
 * quando i = 0. Com n = 1 degenera no próprio aporte.
 * @param aporteMensal PMT em moeda
 * @param taxaMensalFracao i em fração decimal
 * @param prazoMeses n em meses (inteiro ≥ 1)
 */
export function valorFuturoAportesMensais(
  aporteMensal: number,
  taxaMensalFracao: number,
  prazoMeses: number,
): number {
  if (prazoMeses < 1) return 0
  if (taxaMensalFracao === 0) return aporteMensal * prazoMeses
  return (
    aporteMensal *
    (Math.pow(1 + taxaMensalFracao, prazoMeses) - 1) / taxaMensalFracao
  )
}

// ============================================================================
// Séries (REQ-D-002)
// ============================================================================

/**
 * Gera a série mês a mês pela recorrência `saldo(k) = saldo(k−1)·(1+i) + pmt`
 * (pmt = aporte do modo "mensal", 0 no "unico"; depósito único entra como
 * saldo inicial). Retorna exatamente `prazoMeses` pontos.
 */
export function gerarSerieMensal(simulacao: Simulacao): PontoSerie[] {
  validarSimulacao(simulacao)
  const i = taxaMensalEmFracao(simulacao)
  const prazoMeses = simulacao.prazoAnos * 12
  const aporte = simulacao.modo === "mensal" ? simulacao.aporteMensal : 0
  const investimentoInicial =
    simulacao.modo === "unico" ? simulacao.valorInicial : 0

  const pontos: PontoSerie[] = []
  let saldo = investimentoInicial
  let investido = investimentoInicial
  for (let mes = 1; mes <= prazoMeses; mes += 1) {
    saldo = saldo * (1 + i) + aporte
    investido += aporte
    pontos.push(Object.freeze({ mes, valor: saldo, valorInvestido: investido }))
  }
  return pontos
}

/**
 * Gera a série ano a ano colhendo o ponto de mês 12·ano da série mensal —
 * consistência garantida por construção (REQ-D-002). Retorna `prazoAnos`
 * pontos e o último coincide com o último ponto mensal.
 */
export function gerarSerieAnual(simulacao: Simulacao): PontoSerie[] {
  validarSimulacao(simulacao)
  const mensal = gerarSerieMensal(simulacao)
  const anuais: PontoSerie[] = []
  for (let ano = 1; ano <= simulacao.prazoAnos; ano += 1) {
    const ponto = mensal[ano * 12 - 1]
    if (!ponto) {
      throw new RangeError("série mensal inconsistente com o prazo em anos")
    }
    anuais.push(Object.freeze({ ...ponto }))
  }
  return anuais
}

// ============================================================================
// API principal
// ============================================================================

/**
 * Calcula a projeção completa: valor final + séries mensal e anual
 * consistentes. `valorFinal` vem da fórmula fechada (precisão máxima) e é
 * o último ponto exibido (RF-7).
 */
export function calcularProjecao(simulacao: Simulacao): ResultadoProjecao {
  validarSimulacao(simulacao)
  const i = taxaMensalEmFracao(simulacao)
  const prazoMeses = simulacao.prazoAnos * 12

  const valorFinal =
    simulacao.modo === "unico"
      ? valorFuturoDepositoUnico(simulacao.valorInicial, i, prazoMeses)
      : valorFuturoAportesMensais(simulacao.aporteMensal, i, prazoMeses)

  const pontosMensais = gerarSerieMensal(simulacao)
  const pontosAnuais = gerarSerieAnual(simulacao)

  return Object.freeze({
    valorFinal,
    taxaMensalFracao: i,
    pontosMensais: Object.freeze(pontosMensais),
    pontosAnuais: Object.freeze(pontosAnuais),
  })
}
