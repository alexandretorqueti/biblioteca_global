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
import type { CustomAction, DynamicFieldConfig, EntityRecord } from "../types"
import type { JsonRecord } from "./JsonGrid"
import JsonGrid from "./JsonGrid"
import TaskChat from "./TaskChat"
import DynamicForm from "./DynamicForm"

/** Configuração de edição da tela externa. */
export interface ExternalScreenEditConfig {
  /** Método HTTP da requisição de edição (PUT/PATCH/POST). */
  method: "PUT" | "PATCH" | "POST"
  /** Template de caminho com placeholders :campo. */
  pathTemplate: string
  /** Config dos campos do formulário (deriva de DynamicFieldConfig). */
  fields: DynamicFieldConfig[]
  /** Caminho dentro da resposta para extrair o payload JSON; omitido → usa a resposta direta. */
  bodyPath?: string
}

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
  /** Colunas a ocultar na grid (lista e/ou detalhe). */
  hiddenColumns?: string[]
  /** Configuração de edição — quando presente, botões Editar aparecem nas linhas. */
  edit?: ExternalScreenEditConfig
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
  hiddenColumns,
  edit,
}: ExternalScreenProps) {
  const [rawData, setRawData] = useState<unknown | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Ação customizada em execução (id). */
  const [executandoAcao, setExecutandoAcao] = useState<string | null>(null)
  /** Feedback por ação customizada. */
  const [acaoFeedback, setAcaoFeedback] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({})
  /** Estado de visualização: 'list' (grid), 'detail' (detalhe) ou 'edit' (formulário). */
  const [viewMode, setViewMode] = useState<"list" | "detail" | "edit">("list")
  /** Dados do registro selecionado para exibição de detalhe. */
  const [selectedDetailData, setSelectedDetailData] = useState<unknown>(null)
  /** Erro da carga de detalhe (se houver). */
  const [detailError, setDetailError] = useState<string | null>(null)

  /** Dados da linha selecionada para edição. */
  const [editRowData, setEditRowData] = useState<Record<string, unknown> | null>(null)
  /** Feedback de sucesso/erro do submit de edição. */
  const [editFeedback, setEditFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

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
    setEditRowData(null)
  }

  /** Callback: monta URL, envia PUT/PATCH com values e recarrega a grid. */
  const salvarEdicao = async (values: Record<string, string | number | boolean>) => {
    if (!edit || !editRowData) return

    // Montar URL: baseUrl + pathTemplate interpolado com o id da linha.
    let url = (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl)
    if (!url.endsWith("/") && !edit.pathTemplate.startsWith("/")) {
      url += "/"
    }
    let interpolatedUrl = edit.pathTemplate.startsWith("/")
      ? baseUrl.slice(0, -1) + edit.pathTemplate
      : url + edit.pathTemplate
    // Interpolar placeholders do template com os dados da linha (não com params da lista).
    for (const [chave, valor] of Object.entries(editRowData)) {
      if (!String(valor).startsWith("http")) {
        interpolatedUrl = interpolatedUrl.replace(`:${chave}`, String(valor))
      }
    }
    url = interpolatedUrl

    // Montar body: se bodyPath existe, { [bodyPath]: values }, senão values direto.
    const bodyValue = edit.bodyPath ? { [edit.bodyPath]: values } : values
    const payload = JSON.stringify(bodyValue)

    setEditFeedback({ type: "success", message: "Salvando..." })

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`

      const resposta = await fetch(url, {
        method: edit.method,
        headers,
        body: payload,
      })

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

      // Sucesso: voltar à lista e recarregar grid.
      setEditFeedback({ type: "success", message: "Registro salvo com sucesso." })
      void recarregarDados()
      setTimeout(() => {
        voltarLista()
      }, 1200)
    } catch (erro: unknown) {
      setEditFeedback({
        type: "error",
        message: erro instanceof Error ? erro.message : "Erro ao salvar o registro.",
      })
    }
  }

  /** Callback: abre viewMode 'edit' preenchido com os valores da linha. */
  const abrirEdicao = (row: EntityRecord) => {
    setViewMode("edit")
    setEditRowData(toPlainObject(row))
    setEditFeedback(null)
  }

  /** Callback: volta à lista sem refetch. */
  const cancelarEdicao = () => {
    setViewMode("list")
    setEditRowData(null)
    setEditFeedback(null)
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
          <JsonGrid
            data={detailRows}
            getRowId={(row) => String(row._idx)}
            emptyMessage="Detalhe vazio."
            hiddenColumns={hiddenColumns}
          />
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

  // Modo edit — renderiza formulário preenchido com os dados da linha
  if (viewMode === "edit" && edit && editRowData) {
    const initialValues: Record<string, string | number | boolean> = {}
    for (const field of edit.fields) {
      const valor = editRowData[field.name]
      if (valor !== undefined && valor !== null) {
        // Converter para tipo compatível com DynamicFormValues
        if (typeof valor === "boolean") {
          initialValues[field.name] = valor
        } else if (typeof valor === "number") {
          initialValues[field.name] = valor
        } else {
          // string ou objeto/array → JSON stringificado
          initialValues[field.name] = typeof valor === "object" ? JSON.stringify(valor) : String(valor)
        }
      } else {
        initialValues[field.name] = field.defaultValue ?? ""
      }
    }

    return (
      <Stack spacing={2}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton onClick={cancelarEdicao} size="small" aria-label="Cancelar e voltar à lista">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </IconButton>
          <Typography color="text.secondary">Cancelar e voltar à lista</Typography>
        </Box>
        {editFeedback && (
          <Alert severity={editFeedback.type} sx={{ py: 0 }}>
            {editFeedback.message}
          </Alert>
        )}
        <DynamicForm
          fields={edit.fields}
          title="Editar registro"
          submitLabel="Salvar"
          cancelLabel="Cancelar"
          initialValues={initialValues}
          onSubmit={salvarEdicao}
          onCancel={cancelarEdicao}
        />
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
        onEdit={edit ? abrirEdicao : undefined}
        onDelete={undefined}
        hiddenColumns={hiddenColumns}
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
