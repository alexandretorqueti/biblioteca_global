/**
 * ExternalScreen — renderiza dados de um endpoint REST externo na grid.
 *
 * Fetch no mount → loading/erro/vazio → JsonGrid com dados.
 * Usa o pathTemplate do GeradorSistemaConfig para montar a URL.
 *
 * Ações customizadas: quando executeAction NÃO é injetado, dispara
 * HTTP direto contra baseUrl + action.path (com feedback e refresh).
 */
import { useEffect, useMemo, useState } from "react"
import { Alert, Box, Button, IconButton, Paper, Stack, Typography } from "@mui/material"
import type { CustomAction, EntityRecord } from "../types"
import type { JsonRecord } from "./JsonGrid"
import JsonGrid from "./JsonGrid"
import TaskChat from "./TaskChat"

/** Props da tela externa (derivadas de ExternalScreenConfig + runtime). */
interface ExternalScreenProps {
  baseUrl: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  pathTemplate: string
  /** Parâmetros para interpolar no pathTemplate (recebidos do contexto). */
  params?: Record<string, string | number>
  /** Token Bearer opcional. */
  bearerToken?: string
  /** Ações customizadas (botões com estado executando/sucesso/erro). */
  actions?: CustomAction[]
  /** Caminho dentro da resposta para extrair o array de linhas. Ex.: 'projects'. */
  dataPath?: string
  /** Query estática opcional — montada como query string codificada na URL. */
  query?: Record<string, string | number | boolean>
  /** Executa uma ação customizada (injetado pelo runtime; UI não fala HTTP). */
  executeAction?: (
    action: CustomAction,
    context?: { row?: EntityRecord; params?: Record<string, string | number> },
  ) => Promise<{ message: string }>
  /** Template de caminho para detalhe do registro (master-detail). Interpola :campo com os params da linha. */
  detailPathTemplate?: string
  /** Caminho dentro da resposta de detalhe para extrair o objeto de dados. Ex.: 'task'. */
  detailDataPath?: string
  /** Quando true, renderiza TaskChat no modo detail junto com os dados do registro. */
  chat?: boolean
  /** Callback de navegação para abrir detalhe (injetado pelo runtime). */
  onNavigate?: (path: string) => void
}

export default function ExternalScreen({
  baseUrl,
  method,
  pathTemplate,
  params = {},
  bearerToken,
  actions = [],
  dataPath,
  query,
  executeAction,
  detailPathTemplate,
  detailDataPath,
  chat,
}: ExternalScreenProps) {
  const [rawData, setRawData] = useState<unknown | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Ação customizada em execução (id). */
  const [executandoAcao, setExecutandoAcao] = useState<string | null>(null)
  /** Feedback por ação customizada. */
  const [acaoFeedback, setAcaoFeedback] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({})
  /** Estado de visualização: 'list' (grid) ou 'detail' (detalhe). */
  const [viewMode, setViewMode] = useState<"list" | "detail">("list")
  /** Dados do registro selecionado para exibição de detalhe. */
  const [selectedDetailData, setSelectedDetailData] = useState<unknown>(null)
  /** Erro da carga de detalhe (se houver). */
  const [detailError, setDetailError] = useState<string | null>(null)

  // --- carregamento de dados (GET) ------------------------------------------
  useEffect(() => {
    let cancelled = false

    async function carregar() {
      let url = (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl) + pathTemplate
      for (const [chave, valor] of Object.entries(params)) {
        url = url.replace(`:${chave}`, String(valor))
      }

      if (query && typeof query === "object") {
        const parts: string[] = []
        for (const [chave, valor] of Object.entries(query)) {
          if (valor == null) continue
          parts.push(`${encodeURIComponent(chave)}=${encodeURIComponent(String(valor))}`)
        }
        if (parts.length > 0) {
          const separator = url.includes("?") ? "&" : "?"
          url = url + separator + parts.join("&")
        }
      }

      const fetchOptions: RequestInit = {
        method,
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      }

      try {
        const resposta = await fetch(url, fetchOptions)

        if (!resposta.ok) {
          let detalhe: string
          try {
            const corpo = await resposta.json()
            detalhe =
              typeof corpo === "object" && corpo !== null && "message" in corpo
                ? String((corpo as { message?: string }).message)
                : `HTTP ${resposta.status}`
          } catch {
            detalhe = `HTTP ${resposta.status}`
          }
          throw new Error(detalhe)
        }

        const dados = await resposta.json()
        if (cancelled) return

        setRawData(dados)
      } catch (erro: unknown) {
        if (cancelled) return
        setError(erro instanceof Error ? erro.message : "Erro desconhecido")
      }
    }

    carregar()
    return () => { cancelled = true }
  }, [baseUrl, method, pathTemplate, params, bearerToken, query])

  // --- refresh de dados (chamado após ação) ---------------------------------
  const recarregarDados = async () => {
    setError(null)

    let url = (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl) + pathTemplate
    for (const [chave, valor] of Object.entries(params)) {
      url = url.replace(`:${chave}`, String(valor))
    }

    if (query && typeof query === "object") {
      const parts: string[] = []
      for (const [chave, valor] of Object.entries(query)) {
        if (valor == null) continue
        parts.push(`${encodeURIComponent(chave)}=${encodeURIComponent(String(valor))}`)
      }
      if (parts.length > 0) {
        const separator = url.includes("?") ? "&" : "?"
        url = url + separator + parts.join("&")
      }
    }

    try {
      const resposta = await fetch(url, {
        method,
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      })

      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`)

      const dados = await resposta.json()
      setRawData(dados)
    } catch (erro: unknown) {
      setError(erro instanceof Error ? erro.message : "Erro desconhecido")
    }
  }

  // --- master-detail ---------------------------------------------------------
  const carregarDetalhe = async (linha: EntityRecord) => {
    setViewMode("detail")
    setSelectedDetailData(null)
    setDetailError(null)

    let url = (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl) + detailPathTemplate
    for (const [chave, valor] of Object.entries(linha)) {
      if (!String(valor).startsWith("http")) {
        url = url.replace(`:${chave}`, String(valor))
      }
    }

    const fetchOpts: RequestInit = {
      method: "GET",
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
    }

    try {
      const resposta = await fetch(url, fetchOpts)
      if (!resposta.ok) {
        let detalhe: string
        try {
          const corpo = await resposta.json()
          detalhe =
            typeof corpo === "object" && corpo !== null && "message" in corpo
              ? String((corpo as { message?: string }).message)
              : `HTTP ${resposta.status}`
        } catch {
          detalhe = `HTTP ${resposta.status}`
        }
        throw new Error(detalhe)
      }
      const dados = await resposta.json()

      let fonte: unknown = dados
      if (detailDataPath && typeof dados === "object" && dados !== null && !Array.isArray(dados)) {
        const obj = dados as Record<string, unknown>
        if (detailDataPath in obj) fonte = obj[detailDataPath]
      }

      setSelectedDetailData(fonte)
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : "Erro ao carregar detalhe")
    }
  }

  const voltarLista = () => {
    setViewMode("list")
    setSelectedDetailData(null)
    setDetailError(null)
  }

  // --- converter dados → JsonGrid -------------------------------------------
  const rows: JsonRecord[] | null = useMemo(() => {
    if (!rawData) return null

    let source: unknown = rawData
    if (dataPath && typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)) {
      const obj = rawData as Record<string, unknown>
      if (dataPath in obj) source = obj[dataPath]
    }

    if (Array.isArray(source)) {
      return source.map((item, index) => ({ _idx: index, ...toPlainObject(item) })) as unknown as JsonRecord[]
    }
    if (source && typeof source === "object" && !Array.isArray(source)) {
      return [toPlainObject(source)] as unknown as JsonRecord[]
    }
    return null
  }, [rawData, dataPath])

  // --- executar ação customizada ---------------------------------------------
  const executarAcao = async (action: CustomAction) => {
    setExecutandoAcao(action.id)
    setAcaoFeedback((prev) => {
      const next = { ...prev }
      delete next[action.id]
      return next
    })

    try {
      let resultado: { message: string }

      if (executeAction) {
        // Via runtime (api-client injetado).
        resultado = await executeAction(action, { params })
      } else {
        // Direto contra baseUrl + action.path.
        resultado = await executarAcaoExterna(action)
      }

      setAcaoFeedback((prev) => ({
        ...prev,
        [action.id]: { type: "success", message: resultado.message || `Ação "${action.label}" executada com sucesso.` },
      }))
    } catch (acaoError) {
      setAcaoFeedback((prev) => ({
        ...prev,
        [action.id]: {
          type: "error",
          message: acaoError instanceof Error ? acaoError.message : `Não foi possível executar "${action.label}".`,
        },
      }))
    } finally {
      setExecutandoAcao(null)
    }
  }

  // HTTP direto contra baseUrl (sem runtime).
  const executarAcaoExterna = async (action: CustomAction): Promise<{ message: string }> => {
    // Combinar baseUrl + action.path removendo barras extras.
    let url = baseUrl
    if (!url.endsWith("/")) url += "/"
    const trimmedPath = (action.path ?? "").replace(/^\//, "")
    url = trimmedPath ? `${url}${trimmedPath}` : url

    // Interpolar placeholders na URL combinada com os params da tela.
    for (const [chave, valor] of Object.entries(params)) {
      url = url.replace(`:${chave}`, String(valor))
    }

    // Montar query string codificada.
    if (query && typeof query === "object") {
      const parts: string[] = []
      for (const [chave, valor] of Object.entries(query)) {
        if (valor == null) continue
        parts.push(`${encodeURIComponent(chave)}=${encodeURIComponent(String(valor))}`)
      }
      if (parts.length > 0) {
        const separator = url.includes("?") ? "&" : "?"
        url = url + separator + parts.join("&")
      }
    }

    const fetchOptions: RequestInit = {
      method: action.method,
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
    }

    const resposta = await fetch(url, fetchOptions)

    if (!resposta.ok) {
      let detalhe: string
      try {
        const corpo = await resposta.json()
        detalhe =
          typeof corpo === "object" && corpo !== null && "message" in corpo
            ? String((corpo as { message?: string }).message)
            : `HTTP ${resposta.status}`
      } catch {
        detalhe = `HTTP ${resposta.status}`
      }
      throw new Error(detalhe)
    }

    // Refresh após sucesso.
    void recarregarDados()

    return { message: `Ação "${action.label}" executada com sucesso.` }
  }

  // --- renderização ----------------------------------------------------------
  const hasDetailSupport = !!(detailPathTemplate && viewMode === "list")

  if (error) {
    return (
      <Paper sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Typography color="error" variant="h6">Erro ao carregar dados externos</Typography>
          <Typography color="error.text.secondary">{error}</Typography>
        </Stack>
      </Paper>
    )
  }

  // Modo detalhe — carregando
  if (viewMode === "detail" && !selectedDetailData && !detailError) {
    return (
      <Stack spacing={2}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton onClick={voltarLista} size="small" aria-label="Voltar à lista">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </IconButton>
          <Typography color="text.secondary">Voltar à lista</Typography>
        </Box>
        <Paper sx={{ p: 3 }}>
          <Stack spacing={2}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <Typography>Carregando detalhe...</Typography>
            </Box>
          </Stack>
        </Paper>
      </Stack>
    )
  }

  // Modo detalhe — erro
  if (viewMode === "detail" && detailError) {
    return (
      <Stack spacing={2}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton onClick={voltarLista} size="small" aria-label="Voltar à lista">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </IconButton>
          <Typography color="text.secondary">Voltar à lista</Typography>
        </Box>
        <Paper sx={{ p: 3 }}>
          <Stack spacing={2}>
            <Typography color="error" variant="h6">Erro ao carregar detalhe</Typography>
            <Typography color="error.text.secondary">{detailError}</Typography>
          </Stack>
        </Paper>
      </Stack>
    )
  }

  // Modo detalhe — sucesso: exibir JsonGrid com os dados do registro
  if (viewMode === "detail" && selectedDetailData) {
    let detailRows: JsonRecord[] = []
    if (Array.isArray(selectedDetailData)) {
      detailRows = (selectedDetailData as unknown[]).map((item, index) => ({ _idx: index, ...toPlainObject(item) })) as unknown as JsonRecord[]
    } else if (selectedDetailData && typeof selectedDetailData === "object") {
      detailRows = [toPlainObject(selectedDetailData)] as unknown as JsonRecord[]
    }

    return (
      <Stack spacing={2}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton onClick={voltarLista} size="small" aria-label="Voltar à lista">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </IconButton>
          <Typography color="text.secondary">Voltar à lista</Typography>
        </Box>
        {detailRows.length > 0 ? (
          <JsonGrid data={detailRows} getRowId={(row) => String(row._idx)} emptyMessage="Detalhe vazio." />
        ) : (
          <Paper sx={{ p: 3 }}>
            <Typography color="text.secondary">Sem dados para exibir no detalhe.</Typography>
          </Paper>
        )}
        {chat && detailPathTemplate ? (
          <Box sx={{ mt: 2 }}>
            <TaskChat baseUrl="" taskId={String((selectedDetailData as Record<string, unknown>).id ?? "")} />
          </Box>
        ) : null}
      </Stack>
    )
  }

  // Modo lista — carregando
  if (!rows && !executandoAcao) {
    return (
      <Paper sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <Typography>Carregando...</Typography>
          </Box>
        </Stack>
      </Paper>
    )
  }

  return (
    <Stack spacing={2}>
      {actions.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {actions.map((action) => {
            const estado = acaoFeedback[action.id]
            const executando = executandoAcao === action.id
            return (
              <Stack key={action.id} spacing={1} alignItems="flex-start">
                <Button
                  variant="outlined"
                  disabled={executandoAcao !== null}
                  onClick={() => void executarAcao(action)}
                >
                  {executando ? `Executando ${action.label}...` : action.label}
                </Button>
                {estado && (
                  <Alert severity={estado.type} sx={{ py: 0 }}>
                    {estado.message}
                  </Alert>
                )}
              </Stack>
            )
          })}
        </Stack>
      )}
      <JsonGrid
        data={rows || []}
        getRowId={(row) => String(row._idx)}
        emptyMessage="Nenhum registro externo encontrado."
        clickable={hasDetailSupport}
        onRowClick={hasDetailSupport ? (row: JsonRecord) => carregarDetalhe(row as EntityRecord) : undefined}
      />
    </Stack>
  )
}

/** Clona objeto recursivamente para garantir plain object serializável. */
function toPlainObject(input: unknown): Record<string, unknown> {
  if (input == null || typeof input !== "object") return {}
  if (Array.isArray(input)) {
    return input.map(toPlainObject) as unknown as Record<string, unknown>
  }
  const result: Record<string, unknown> = {}
  for (const [key, valor] of Object.entries(input as Record<string, unknown>)) {
    result[key] = typeof valor === "object" && valor !== null ? toPlainObject(valor) : valor
  }
  return result
}
