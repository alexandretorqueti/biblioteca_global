/**
 * CalculadoraScreen — formulário de simulação e resultado do projeto
 * `calculadora-de-investimentos-gabriel` (plano macro #6, posição 4/9 —
 * REQ-F-002, REQ-F-004, REQ-F-006, REQ-D-001, REQ-NF-001).
 *
 * Formulário (tudo em memória — useState/useMemo; sem persistência, sem
 * POST/PUT/PATCH/DELETE):
 * - toggle depósito único × aportes mensais (RF-2) alternando o campo de
 *   valor (valorInicial ↔ aporteMensal);
 * - select de índices ativos lidos do CRUD (GET `indices` ordenado por
 *   `ordem`) via `useApi()` + `RestEntityClient` (transporte só na
 *   api-client — PoC §7);
 * - taxa manual em % a.a. com precedência sobre a cotação quando
 *   preenchida, cobrindo índice não listado (RF-4);
 * - prazo em anos (inteiro ≥ 1).
 *
 * Cotação automática: `resolverCotacao` roda NO NAVEGADOR (CORS da SGS
 * verificado ao vivo em 2026-11-23 — `access-control-allow-origin: *`; o
 * módulo é TS puro com fetch injetável, e DECISOES-COTACOES.md §7 previa
 * exatamente esta reavaliação quando a UI evoluísse para chamada direta).
 * A taxa exibida é SEMPRE a mensal (RF-6): `Cotacao.taxaMensal` da fonte,
 * ou `converterAnualParaMensal` para a taxa manual anual — a fórmula nunca
 * é reimplementada nem a taxa anual exibida como taxa de cálculo.
 *
 * Valor final via `calcularProjecao` (useMemo — recalcula a cada mudança,
 * sem botão de submissão), formatado em BRL por `Intl` pt-BR. Estados de
 * carregamento/erro/fallback da cotação visíveis; erro tipado não derruba
 * a tela. `componentId` inalterado (config.ts e registry.ts não mudam).
 *
 * Gráfico da evolução (RF-7, posição 5/9): `GraficoEvolucao` abaixo do
 * valor final, consumindo `pontosAnuais`/`pontosMensais` JÁ produzidos pelo
 * useMemo da projeção — o toggle anual/mensal é estado local de visão e
 * apenas troca a série exibida (nenhum recálculo ao alternar).
 *
 * Responsividade/acessibilidade (REQ-NF-002, posição 6/9): TextField do
 * formulário com `fullWidth` (sem largura intrínseca estourando 360px),
 * paddings adaptativos `p: { xs: 2, sm: 3 }` nos Papers, alvos de toque dos
 * ToggleButtonGroups elevados a `minHeight: 44` em todos os breakpoints sem
 * redesenhar (size `small` preservado); `maxWidth: 720` e o layout do
 * resultado (`direction={{ xs: 'column', sm: 'row' }}`) mantidos. Ordem de
 * tabulação natural (DOM sem tabIndex positivo); SVG do gráfico já expõe
 * `role="img"` + `aria-label` (GraficoEvolucao); erros/hints via helperText
 * do próprio campo.
 */
import { useEffect, useMemo, useState } from "react"
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material"
import type { CustomScreenProps } from "@biblioteca-global/ui"
import type { EntityRecord, PaginatedResult } from "@biblioteca-global/shared"
import { RestEntityClient } from "@biblioteca-global/api-client"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"
import { calcularProjecao, type ModoAporte } from "../calculo/projecao"
import GraficoEvolucao, { type PeriodoGrafico } from "./GraficoEvolucao"
import {
  converterAnualParaMensal,
  resolverCotacao,
  type Cotacao,
  type CotacaoError,
} from "../cotacoes/resolverCotacoes"

export const componentId = "calculadora-de-investimentos-gabriel-calculadora"

// ============================================================================
// Tipos e utilidades puras (exportadas para teste)
// ============================================================================

/** Linha do cadastro `indices` (colunas decimal/bigint podem vir como string). */
interface IndiceRecord extends EntityRecord {
  readonly nome?: unknown
  readonly sigla?: unknown
  readonly taxaAnual?: unknown
  readonly ordem?: unknown
}

/** Converte texto numérico do formulário (aceita vírgula decimal) em número finito. */
export function parsearNumeroInput(texto: string): number | null {
  const limpo = texto.trim().replace(",", ".")
  if (limpo === "") return null
  const numero = Number(limpo)
  return Number.isFinite(numero) ? numero : null
}

/** Inteiro ≥ 1 do campo de prazo; null quando inválido (a tela então não projeta). */
export function parsearPrazoAnos(texto: string): number | null {
  const numero = parsearNumeroInput(texto)
  if (numero === null || !Number.isInteger(numero) || numero < 1) return null
  return numero
}

/**
 * Taxa anual do cadastro usada como `taxaAnualFallback` do resolvedor.
 * O schema usa default `0` para "sem taxa informada" — 0 não é fallback
 * útil (mascararia erros de fonte com rentabilidade zero), então só
 * valores > 0 são aproveitados; caso contrário a falha vira erro tipado.
 */
export function taxaAnualDeCadastro(indice: IndiceRecord): number | null {
  const taxa = parsearNumeroInput(String(indice.taxaAnual ?? ""))
  return taxa !== null && taxa > 0 ? taxa : null
}

const FORMATADOR_BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
})

/** Valor monetário em R$ (pt-BR). */
export function formatarBRL(valor: number): string {
  return FORMATADOR_BRL.format(valor)
}

/** Taxa mensal em % (RF-6: é a única taxa exibida como taxa de cálculo). */
export function formatarTaxaMensal(taxaMensalPercentual: number): string {
  return `${taxaMensalPercentual.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}% ao mês`
}

/**
 * Série exibida no gráfico (RF-7): apenas COLHE a série memoizada conforme a
 * visão — não recalcula nada. Anual: `prazoAnos` pontos; mensal:
 * `prazoAnos · 12` pontos (invariantes REQ-D-002 do motor).
 */
export function serieDoGrafico(
  projecao: ReturnType<typeof calcularProjecao> | null,
  visao: PeriodoGrafico,
): ReturnType<typeof calcularProjecao>["pontosAnuais"] | null {
  if (!projecao) return null
  return visao === "anual" ? projecao.pontosAnuais : projecao.pontosMensais
}

/** Normaliza coluna numérica vinda do CRUD (string/number) para ordenar. */
function numeroDe(valor: unknown): number {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0
  const numero = parsearNumeroInput(String(valor ?? ""))
  return numero ?? 0
}

// ============================================================================
// Componente
// ============================================================================

export default function CalculadoraScreen(_props: CustomScreenProps) {
  void _props
  const api = useApi()
  const auth = useAuth()
  const slug = auth?.projeto?.slug ?? null

  // ── Estado do formulário (100% em memória — REQ: simulação efêmera) ──
  const [modo, setModo] = useState<ModoAporte>("unico")
  const [valorInicialTexto, setValorInicialTexto] = useState("1000")
  const [aporteMensalTexto, setAporteMensalTexto] = useState("100")
  const [siglaIndice, setSiglaIndice] = useState("")
  const [taxaManualTexto, setTaxaManualTexto] = useState("")
  const [prazoTexto, setPrazoTexto] = useState("1")

  // ── Visão do gráfico (RF-7): estado local — alternar NÃO recalcula ──
  const [visaoGrafico, setVisaoGrafico] = useState<PeriodoGrafico>("anual")

  // ── Estado da leitura do cadastro de índices (GET) ──
  const [indices, setIndices] = useState<readonly IndiceRecord[]>([])
  const [erroIndices, setErroIndices] = useState<string | null>(null)

  // ── Estado da cotação (loading/erro/fallback visíveis) ──
  const [cotacao, setCotacao] = useState<Cotacao | null>(null)
  const [erroCotacao, setErroCotacao] = useState<CotacaoError | null>(null)
  const [carregandoCotacao, setCarregandoCotacao] = useState(false)

  // Cliente de entidade do recurso 'indices' (transporte só via api-client).
  const http = api?.http
  const clienteIndices = useMemo(
    () =>
      http && slug
        ? new RestEntityClient<IndiceRecord>(http, slug, "indices")
        : null,
    [http, slug],
  )

  // Carga inicial dos índices ativos via CRUD GET, ordenados por `ordem`.
  useEffect(() => {
    if (!clienteIndices) return
    let ativo = true
    void (async () => {
      try {
        const pagina: PaginatedResult<IndiceRecord> = await clienteIndices.list({
          pageSize: 100,
          orderBy: [{ campo: "ordem", direction: "asc" }],
        })
        if (!ativo) return
        const ordenados = [...pagina.items].sort(
          (a, b) =>
            numeroDe(a.ordem) - numeroDe(b.ordem) ||
            String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR"),
        )
        setIndices(ordenados)
        setErroIndices(null)
      } catch (cause) {
        if (!ativo) return
        setErroIndices(
          cause instanceof Error
            ? cause.message
            : "Não foi possível carregar os índices.",
        )
      }
    })()
    return () => {
      ativo = false
    }
  }, [clienteIndices])

  const indiceSelecionado = useMemo(
    () => indices.find((item) => String(item.sigla) === siglaIndice) ?? null,
    [indices, siglaIndice],
  )

  const taxaManualAnual = parsearNumeroInput(taxaManualTexto)
  const taxaManualValida = taxaManualAnual !== null && taxaManualAnual >= 0

  // Cotação automática ao selecionar índice (RF-3/RF-6). Com taxa manual
  // válida, a seleção é ignorada (RF-4) e nenhuma busca é disparada.
  useEffect(() => {
    if (!indiceSelecionado || taxaManualValida) {
      setCotacao(null)
      setErroCotacao(null)
      setCarregandoCotacao(false)
      return
    }
    let ativo = true
    setCarregandoCotacao(true)
    setErroCotacao(null)
    void resolverCotacao({
      sigla: String(indiceSelecionado.sigla),
      taxaAnualFallback: taxaAnualDeCadastro(indiceSelecionado),
    }).then((resultado) => {
      if (!ativo) return
      if (resultado.ok) {
        setCotacao(resultado.cotacao)
        setErroCotacao(null)
      } else {
        setCotacao(null)
        setErroCotacao(resultado.error)
      }
      setCarregandoCotacao(false)
    })
    return () => {
      ativo = false
    }
  }, [indiceSelecionado, taxaManualValida])

  // Taxa mensal efetiva do cálculo (RF-6): sempre mensal; taxa manual anual
  // convertida pela função compartilhada. Precedência: manual > cotação.
  const taxaMensalEfetiva = useMemo(() => {
    if (taxaManualAnual !== null && taxaManualAnual >= 0) {
      return converterAnualParaMensal(taxaManualAnual)
    }
    if (cotacao) return cotacao.taxaMensal
    return null
  }, [taxaManualAnual, cotacao])

  // Projeção recalculada a cada mudança de aporte/taxa/prazo (sem submissão).
  const projecao = useMemo(() => {
    const valor =
      modo === "unico"
        ? parsearNumeroInput(valorInicialTexto)
        : parsearNumeroInput(aporteMensalTexto)
    const prazoAnos = parsearPrazoAnos(prazoTexto)
    if (valor === null || valor < 0) return null
    // (validação compartilhada com o badge do campo — ver valorInvalido)
    if (prazoAnos === null) return null
    if (taxaMensalEfetiva === null) return null
    try {
      return calcularProjecao(
        modo === "unico"
          ? {
              modo: "unico",
              valorInicial: valor,
              prazoAnos,
              taxaMensalPercentual: taxaMensalEfetiva,
            }
          : {
              modo: "mensal",
              aporteMensal: valor,
              prazoAnos,
              taxaMensalPercentual: taxaMensalEfetiva,
            },
      )
    } catch {
      return null
    }
  }, [modo, valorInicialTexto, aporteMensalTexto, prazoTexto, taxaMensalEfetiva])

  const prazoInvalido =
    prazoTexto.trim() !== "" && parsearPrazoAnos(prazoTexto) === null
  const valorDoFormulario = parsearNumeroInput(
    modo === "unico" ? valorInicialTexto : aporteMensalTexto,
  )
  const valorInvalido = valorDoFormulario === null || valorDoFormulario < 0
  const taxaManualInvalida =
    taxaManualTexto.trim() !== "" && !taxaManualValida

  const origemTaxa = taxaManualValida
    ? "Taxa manual informada (ao ano, convertida por juros compostos)"
    : cotacao
      ? `Índice ${cotacao.sigla} — cotação ${cotacao.fonte} em ${new Date(
          cotacao.capturadaEm,
        ).toLocaleString("pt-BR")}`
      : "Selecione um índice ou informe uma taxa manual"
  const usandoFallback = cotacao !== null && cotacao.fonte.startsWith("fallback")

  return (
    <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, maxWidth: 720 }} data-testid="calculadora-screen">
      <Box>
        <Typography variant="h5" fontWeight={800}>
          Calculadora de Investimentos
        </Typography>
        <Typography color="text.secondary">
          Simule rendimento com índice (cotação automática do Banco Central)
          ou taxa manual. Nada é salvo: a simulação é apenas exibida.
        </Typography>
      </Box>

      {erroIndices && (
        <Alert severity="error" data-testid="erro-indices">
          {erroIndices}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, borderRadius: 2 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Tipo de aporte
            </Typography>
            <ToggleButtonGroup
              exclusive
              value={modo}
              onChange={(_evento, novoModo: ModoAporte | null) => {
                if (novoModo) setModo(novoModo)
              }}
              aria-label="Tipo de aporte"
              size="small"
              sx={{ "& .MuiToggleButton-root": { minHeight: 44 } }}
            >
              <ToggleButton value="unico">Depósito único</ToggleButton>
              <ToggleButton value="mensal">Aportes mensais</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {modo === "unico" ? (
            <TextField
              label="Valor do depósito único (R$)"
              value={valorInicialTexto}
              onChange={(evento) => setValorInicialTexto(evento.target.value)}
              inputMode="decimal"
              size="small"
              fullWidth
              error={valorInvalido}
              helperText={valorInvalido ? "Informe um valor ≥ 0" : undefined}
            />
          ) : (
            <TextField
              label="Aporte mensal (R$)"
              value={aporteMensalTexto}
              onChange={(evento) => setAporteMensalTexto(evento.target.value)}
              inputMode="decimal"
              size="small"
              fullWidth
              error={valorInvalido}
              helperText={valorInvalido ? "Informe um valor ≥ 0" : undefined}
            />
          )}

          <FormControl size="small" fullWidth>
            <InputLabel id="calculadora-indice-label">Índice</InputLabel>
            <Select
              id="calculadora-indice"
              labelId="calculadora-indice-label"
              label="Índice"
              value={siglaIndice}
              onChange={(evento) => setSiglaIndice(evento.target.value)}
            >
              <MenuItem value="">Nenhum (use taxa manual)</MenuItem>
              {indices.map((indice) => (
                <MenuItem key={String(indice.sigla)} value={String(indice.sigla)}>
                  {String(indice.nome)} ({String(indice.sigla)})
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Taxa manual (% ao ano)"
            value={taxaManualTexto}
            onChange={(evento) => setTaxaManualTexto(evento.target.value)}
            inputMode="decimal"
            size="small"
            fullWidth
            error={taxaManualInvalida}
            helperText={
              taxaManualInvalida
                ? "Informe uma taxa ≥ 0"
                : "Preenchida, tem prioridade sobre a cotação do índice e permite simular sem índice cadastrado"
            }
          />

          <TextField
            label="Prazo (anos)"
            value={prazoTexto}
            onChange={(evento) => setPrazoTexto(evento.target.value)}
            inputMode="numeric"
            size="small"
            fullWidth
            sx={{ maxWidth: 220 }}
            error={prazoInvalido}
            helperText={prazoInvalido ? "Informe um inteiro ≥ 1" : undefined}
          />
        </Stack>
      </Paper>

      {carregandoCotacao && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          data-testid="carregando-cotacao"
        >
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            Consultando cotação do índice…
          </Typography>
        </Stack>
      )}

      {erroCotacao && (
        <Alert severity="warning" data-testid="erro-cotacao">
          Não foi possível obter a cotação ({erroCotacao.code}):{" "}
          {erroCotacao.mensagem} Preencha a taxa manual para continuar.
        </Alert>
      )}

      {usandoFallback && (
        <Alert severity="info" data-testid="alerta-fallback">
          Fonte de cotação indisponível; usando a taxa anual do cadastro do
          índice como fallback.
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{ p: { xs: 2, sm: 3 }, borderRadius: 2 }}
        data-testid="resultado-simulacao"
      >
        <Stack direction={{ xs: "column", sm: "row" }} spacing={3}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Taxa mensal
            </Typography>
            <Typography variant="h6" data-testid="taxa-mensal">
              {taxaMensalEfetiva !== null
                ? formatarTaxaMensal(taxaMensalEfetiva)
                : "—"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {origemTaxa}
            </Typography>
          </Box>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Valor final
            </Typography>
            <Typography variant="h4" fontWeight={800} data-testid="valor-final">
              {projecao ? formatarBRL(projecao.valorFinal) : "—"}
            </Typography>
          </Box>
        </Stack>
      </Paper>

      {projecao && (
        <Paper
          variant="outlined"
          sx={{ p: { xs: 2, sm: 3 }, borderRadius: 2, maxWidth: "100%", overflow: "hidden" }}
          data-testid="painel-grafico"
        >
          <Stack spacing={1.5}>
            <Stack
              direction="row"
              spacing={2}
              alignItems="center"
              justifyContent="space-between"
              flexWrap="wrap"
            >
              <Typography variant="subtitle2">
                Evolução do investimento
              </Typography>
              <ToggleButtonGroup
                exclusive
                value={visaoGrafico}
                onChange={(_evento, novaVisao: PeriodoGrafico | null) => {
                  if (novaVisao) setVisaoGrafico(novaVisao)
                }}
                aria-label="Alternância anual/mensal do gráfico"
                size="small"
                sx={{ "& .MuiToggleButton-root": { minHeight: 44 } }}
              >
                <ToggleButton value="anual">Ano a ano</ToggleButton>
                <ToggleButton value="mensal">Mês a mês</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            <GraficoEvolucao
              pontos={serieDoGrafico(projecao, visaoGrafico) ?? []}
              periodo={visaoGrafico}
              formatarValor={formatarBRL}
            />
          </Stack>
        </Paper>
      )}
    </Stack>
  )
}
