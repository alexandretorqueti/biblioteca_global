/**
 * GraficoEvolucao — gráfico da evolução do investimento (plano macro #6,
 * posição 5/9 — REQ-F-007/RF-7).
 *
 * Componente React PURO (props → SVG): sem HTTP, sem estado global, sem
 * recálculo — consome as séries já produzidas por `calcularProjecao`
 * (`pontosMensais`/`pontosAnuais`, REQ-D-002 preservada; o motor não é
 * tocado aqui). A alternância anual/mensal é decisão da tela (estado local
 * de visão), este componente apenas renderiza a série recebida.
 *
 * Decisão técnica (registrada na subtarefa): SVG próprio com `viewBox` em
 * vez de recharts — a plataforma não tem componente nativo de gráfico
 * (lacuna confirmada: nenhuma lib de chart em `packages/ui`, `apps/web` ou
 * node_modules) e a regra do workspace é não introduzir dependência nova
 * sem solução interna. O `viewBox` com `width="100%"` cobre responsividade
 * (legível em 360px e desktop) sem ResizeObserver; eixo Y com ticks em BRL
 * via `Intl` pt-BR; tooltip por ponto via `<title>` SVG (período + saldo,
 * sempre presente no DOM) realçado por texto ao passar o mouse.
 */
import { useMemo, useState } from "react"
import { Box, Typography } from "@mui/material"
import type { PontoSerie } from "../calculo/projecao"

// ============================================================================
// Tipos e utilidades puras (exportadas para teste)
// ============================================================================

/** Visão de período do gráfico (RF-7): colheita anual ou passo mensal. */
export type PeriodoGrafico = "mensal" | "anual"

/** Rótulo do período de um ponto: "Mês k" ou "Ano k" (mes é 1-based). */
export function rotuloDoPeriodo(periodo: PeriodoGrafico, mes: number): string {
  if (periodo === "anual") return `Ano ${Math.round(mes / 12)}`
  return `Mês ${mes}`
}

export interface GraficoEvolucaoProps {
  /** Série a exibir (mensal ou anual, já memoizada pela tela). */
  readonly pontos: readonly PontoSerie[]
  /** Período dos pontos (define os rótulos do tooltip). */
  readonly periodo: PeriodoGrafico
  /** Formatter monetário (BRL pt-BR por padrão). */
  readonly formatarValor?: (valor: number) => string
}

const FORMATADOR_BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
})

/** Ticks do eixo Y: BRL sem centavos (rótulos curtos, legíveis em 360px). */
const FORMATADOR_TICK = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
})

// ============================================================================
// Geometria (viewBox fixo — o navegador escala; sem ResizeObserver)
// ============================================================================

const LARGURA = 480
const ALTURA = 240
const MARGEM = { topo: 18, direita: 14, fundo: 26, esquerda: 86 }
const QUANTIDADE_TICKS = 5

interface Geometria {
  readonly x: (indice: number) => number
  readonly y: (valor: number) => number
  readonly caminhoLinha: string
  readonly caminhoArea: string
  readonly ticks: readonly number[]
  readonly linhaBase: number
}

/**
 * Escala linear com base em 0 (séries de saldo são não-negativas) e o
 * máximo da série. Um único ponto degenera no centro horizontal.
 */
export function calcularGeometria(
  pontos: readonly PontoSerie[],
): Geometria | null {
  if (pontos.length === 0) return null
  const larguraUtil = LARGURA - MARGEM.esquerda - MARGEM.direita
  const alturaUtil = ALTURA - MARGEM.topo - MARGEM.fundo
  const linhaBase = MARGEM.topo + alturaUtil
  const maximo = Math.max(...pontos.map((p) => p.valor), 0)
  const escala = maximo > 0 ? maximo : 1

  const x = (indice: number): number =>
    pontos.length === 1
      ? MARGEM.esquerda + larguraUtil / 2
      : MARGEM.esquerda + (indice * larguraUtil) / (pontos.length - 1)
  const y = (valor: number): number =>
    MARGEM.topo + alturaUtil * (1 - Math.max(0, Math.min(valor, maximo)) / escala)

  const caminhoLinha = pontos
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.valor).toFixed(2)}`)
    .join(" ")
  const caminhoArea =
    `${caminhoLinha} L${x(pontos.length - 1).toFixed(2)},${linhaBase.toFixed(2)}` +
    ` L${x(0).toFixed(2)},${linhaBase.toFixed(2)} Z`

  const ticks = Array.from(
    { length: QUANTIDADE_TICKS },
    (_, i) => (maximo * i) / (QUANTIDADE_TICKS - 1),
  )

  return { x, y, caminhoLinha, caminhoArea, ticks, linhaBase }
}

// ============================================================================
// Componente
// ============================================================================

export default function GraficoEvolucao({
  pontos,
  periodo,
  formatarValor = (valor: number) => FORMATADOR_BRL.format(valor),
}: GraficoEvolucaoProps) {
  const [indiceAtivo, setIndiceAtivo] = useState<number | null>(null)

  const geometria = useMemo(() => calcularGeometria(pontos), [pontos])

  if (!geometria || pontos.length === 0) return null

  const pontoAtivo = indiceAtivo !== null ? pontos[indiceAtivo] : null
  const textoTooltip = pontoAtivo
    ? `${rotuloDoPeriodo(periodo, pontoAtivo.mes)} — ${formatarValor(pontoAtivo.valor)}`
    : null

  return (
    <Box
      data-testid="grafico-evolucao"
      sx={{ width: "100%", overflow: "visible", color: "primary.main" }}
    >
      <svg
        viewBox={`0 0 ${String(LARGURA)} ${String(ALTURA)}`}
        width="100%"
        role="img"
        aria-label={`Gráfico da evolução do investimento, visão ${periodo === "anual" ? "ano a ano" : "mês a mês"}`}
        style={{ display: "block", fontFamily: "inherit" }}
        onMouseLeave={() => {
          setIndiceAtivo(null)
        }}
      >
        {/* Eixo Y: ticks em BRL (Intl pt-BR) com linhas-guia horizontais */}
        {geometria.ticks.map((tick) => (
          <g key={`tick-${tick.toFixed(2)}`}>
            <line
              x1={MARGEM.esquerda}
              x2={LARGURA - MARGEM.direita}
              y1={geometria.y(tick)}
              y2={geometria.y(tick)}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            />
            <text
              x={MARGEM.esquerda - 8}
              y={geometria.y(tick) + 4}
              textAnchor="end"
              fontSize={12}
              fill="currentColor"
              fillOpacity={0.65}
            >
              {FORMATADOR_TICK.format(tick)}
            </text>
          </g>
        ))}

        {/* Área + linha da série */}
        <path d={geometria.caminhoArea} fill="currentColor" fillOpacity={0.12} />
        <path
          d={geometria.caminhoLinha}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Pontos com tooltip por ponto (período + saldo, sempre no DOM) */}
        {pontos.map((ponto, indice) => (
          <circle
            key={`ponto-${String(ponto.mes)}`}
            data-testid="ponto-grafico"
            cx={geometria.x(indice)}
            cy={geometria.y(ponto.valor)}
            r={indice === indiceAtivo ? 5 : 3}
            fill="currentColor"
            fillOpacity={indice === indiceAtivo ? 1 : 0.8}
            onMouseEnter={() => {
              setIndiceAtivo(indice)
            }}
          >
            <title>
              {`${rotuloDoPeriodo(periodo, ponto.mes)} — ${formatarValor(ponto.valor)}`}
            </title>
          </circle>
        ))}

        {/* Linha de base do eixo X */}
        <line
          x1={MARGEM.esquerda}
          x2={LARGURA - MARGEM.direita}
          y1={geometria.linhaBase}
          y2={geometria.linhaBase}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
        />

        {/* Tooltip destacado do ponto sob o mouse */}
        {textoTooltip && (
          <text
            data-testid="tooltip-grafico"
            x={LARGURA - MARGEM.direita}
            y={12}
            textAnchor="end"
            fontSize={13}
            fontWeight={700}
            fill="currentColor"
            fillOpacity={0.9}
          >
            {textoTooltip}
          </text>
        )}
      </svg>
      <Typography variant="caption" color="text.secondary">
        Evolução do saldo — visão{" "}
        {periodo === "anual" ? "ano a ano" : "mês a mês"} ·{" "}
        {String(pontos.length)}{" "}
        {pontos.length === 1 ? "ponto" : "pontos"}
      </Typography>
    </Box>
  )
}
