/**
 * OcorrenciaScreen — tela custom de ocorrência/devolução para portaria/triagem.
 *
 * Fluxo:
 * 1. Selecionar uma encomenda (busca por código, ID ou unidade).
 * 2. Escolher tipo de ocorrência (enum do schema).
 * 3. Preencher motivo (mín. 10 caracteres).
 * 4. Preencher descrição quando tipo = 'outro'.
 * 5. Upload opcional de foto/evidência via câmera ou arquivo.
 * 6. Enviar POST /api/ocorrencias → encomenda atualizada para 'cancelada'.
 * 7. Confirmação com resumo da ocorrência registrada.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import {
  CheckCircleRounded,
  CloseRounded,
  DeleteSweepRounded,
  DescriptionRounded,
  PhotoCameraRounded,
  WarningAmberRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

// ============================================================================
// TIPOS
// ============================================================================

const OCORRENCIA_TIPOS = [
  { value: "devolucao_transportadora", label: "Devolução pela transportadora" },
  { value: "extravio", label: "Extravio" },
  { value: "recusada", label: "Recusada pelo morador" },
  { value: "endereco_incorreto", label: "Endereço incorreto" },
  { value: "outro", label: "Outro" },
] as const

type OcorrenciaTipo = (typeof OCORRENCIA_TIPOS)[number]["value"]

interface EncomendaSelecao {
  id: number
  codigoRastreamento: string | null
  unidadeLabel: string | null
  transportadoraNome: string | null
  status: string
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function OcorrenciaScreen(): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()

  // ---- Estado geral ----
  const [estado, setEstado] = useState<"form" | "success" | "error">("form")
  const [erroMsg, setErroMsg] = useState<string | null>(null)

  // ---- Busca de encomenda ----
  const [buscaEncomenda, setBuscaEncomenda] = useState("")
  const [opcoesEncomenda, setOpcoesEncomenda] = useState<EncomendaSelecao[]>([])
  const [encomendaSelecionada, setEncomendaSelecionada] =
    useState<EncomendaSelecao | null>(null)
  const [buscandoEncomenda, setBuscandoEncomenda] = useState(false)

  // ---- Formulário de ocorrência ----
  const [tipo, setTipo] = useState<OcorrenciaTipo>("extravio")
  const [motivo, setMotivo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [fotoUrl, setFotoUrl] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  // ---- Motivos sugeridos por tipo ----
  const motivosSugeridos: Record<OcorrenciaTipo, string[]> = useMemo(
    () => ({
      devolucao_transportadora: [
        "Transportadora veio buscar a encomenda sem aviso prévio",
        "Encomenda devolvida pelo destinatário na entrega",
        "Correio retornou a encomenda — endereço incompleto",
        "Loja solicitou devolução da mercadoria",
      ],
      extravio: [
        "Encomenda não localizada no setor de triagem após busca",
        "Caixa danificada sem conteúdo no recebimento",
        "Encomenda encontrada fora do local designado",
      ],
      recusada: [
        "Morador recusou o recebimento no ato da entrega",
        "Ninguém estava no endereço para receber a encomenda",
        "Morador recusou por conteúdo diferente do esperado",
      ],
      endereco_incorreto: [
        "Unidade informada não existe no condomínio",
        "Destinatário não mora mais na unidade informada",
        "Endereço de entrega fora da área de cobertura",
      ],
      outro: [],
    }),
    [],
  )

  // ---- Busca de encomenda com debounce ----
  useEffect(() => {
    if (!bundle || !projeto || buscaEncomenda.length < 2) return
    const timer = setTimeout(async () => {
      setBuscandoEncomenda(true)
      try {
        const result = await bundle.http.request<{ items: EncomendaSelecao[] }>(
          "GET",
          `/${projeto.slug}/encomendas`,
          { query: { busca: buscaEncomenda, pageSize: 20 }, auth: "access" },
        )
        // Filtrar apenas encomendas com status que permite ocorrência
        setOpcoesEncomenda(
          (result.items ?? []).filter(
            (e) => e.status === "pendente" || e.status === "pronta_retirada",
          ),
        )
      } catch {
        // Silencioso — sem resultados de busca
      } finally {
        setBuscandoEncomenda(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [bundle, projeto, buscaEncomenda])

  // ---- Upload de foto ----
  const handleCapturaFoto = useCallback(
    async (source: "camera" | "file") => {
      try {
        let mediaData: { data: string; type: string } | null = null

        if (source === "camera") {
          // Tenta usar a API de câmera do navegador
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
          })
          const canvas = document.createElement("canvas")
          const videoEl = document.createElement("video")
          videoEl.srcObject = stream
          await new Promise<void>((resolve) => {
            videoEl.onloadedmetadata = () => {
              videoEl.play()
              setTimeout(resolve, 500)
            }
          })
          canvas.width = videoEl.videoWidth
          canvas.height = videoEl.videoHeight
          const ctx = canvas.getContext("2d")
          if (ctx) ctx.drawImage(videoEl, 0, 0)
          mediaData = { data: canvas.toDataURL("image/jpeg", 0.8), type: "image/jpeg" }
          stream.getTracks().forEach((t) => t.stop())
        } else {
          // Fallback: input file para captura de foto
          const input = document.createElement("input")
          input.type = "file"
          input.accept = "image/*"
          const file = await new Promise<File | null>((resolve) => {
            input.onchange = () => resolve(input.files?.[0] ?? null)
            input.click()
          })
          if (file) {
            mediaData = await new Promise<{ data: string; type: string }>((resolve) => {
              const reader = new FileReader()
              reader.onload = () =>
                resolve({ data: reader.result as string, type: file.type })
              reader.readAsDataURL(file)
            })
          }
        }

        if (mediaData) setFotoUrl(mediaData.data)
      } catch {
        // Câmera não disponível — mantém sem foto
        setErroMsg("Câmera indisponível. Você pode tentar carregar uma foto do disco.")
      }
    },
    [],
  )

  const handleRemoverFoto = useCallback(() => {
    setFotoUrl(null)
  }, [])

  // ---- Envio ----
  const enviarOcorrencia = useCallback(async () => {
    if (!bundle || !projeto || !encomendaSelecionada) return

    // Validações
    if (motivo.length < 10) {
      setErroMsg("O motivo deve ter pelo menos 10 caracteres.")
      return
    }
    if (tipo === "outro" && descricao.trim().length === 0) {
      setErroMsg("A descrição é obrigatória quando o tipo é 'Outro'.")
      return
    }

    // Busca funcionários para selecionar o registrante
    let funcionarioId: number | null = null
    try {
      const fResult = await bundle.http.request<{
        items: Array<{
          id: number
          nome: string
          funcao: "triagem" | "portaria" | "ambos"
        }>
      }>(
        "GET",
        `/${projeto.slug}/funcionarios`,
        { query: { pageSize: 200 }, auth: "access" },
      )
      const funcionarios = (fResult.items ?? []).filter(
        (f) => f.funcao === "portaria" || f.funcao === "ambos",
      )
      // Usa o primeiro — simplificação para a tela custom
      const primeiroFuncionario = funcionarios[0]
      if (primeiroFuncionario) funcionarioId = primeiroFuncionario.id
    } catch {
      setErroMsg("Não foi possível localizar funcionários para registrar a ocorrência.")
      return
    }

    setEnviando(true)
    setErroMsg(null)

    try {
      const payload: Record<string, unknown> = {
        encomendaId: encomendaSelecionada.id,
        condominioId: encomendaSelecionada.id, // placeholder — backend resolve pelo condomínio da encomenda
        registradoPorId: funcionarioId,
        tipo,
        motivo,
        devolvidaTransportadora: false,
      }

      if (tipo === "outro") {
        payload.descricao = descricao.trim()
      }
      if (fotoUrl) {
        payload.fotoEvidenciaUrl = fotoUrl
      }

      // 1. POST /ocorrencias
      await bundle.http.request(
        "POST",
        `/${projeto.slug}/ocorrencias`,
        { body: payload, auth: "access" },
      )

      // 2. PATCH encomenda → cancelada com motivoCancelamento
      await bundle.http.request(
        "PATCH",
        `/${projeto.slug}/encomendas/${encomendaSelecionada.id}`,
        {
          body: {
            status: "cancelada",
            motivoCancelamento: `Ocorrência do tipo ${tipo}: ${motivo.substring(0, 200)}`,
          },
          auth: "access",
        },
      )

      setEstado("success")
    } catch (error) {
      setErroMsg(
        error instanceof Error ? error.message : "Não foi possível registrar a ocorrência.",
      )
      setEstado("error")
    } finally {
      setEnviando(false)
    }
  }, [bundle, projeto, encomendaSelecionada, tipo, motivo, descricao, fotoUrl])

  // ---- Handlers de reinício ----
  const handleNovaOcorrencia = useCallback(() => {
    setEstado("form")
    setEncomendaSelecionada(null)
    setBuscaEncomenda("")
    setOpcoesEncomenda([])
    setTipo("extravio")
    setMotivo("")
    setDescricao("")
    setFotoUrl(null)
  }, [])

  // ---- Labels e validação inline ----
  const motivoInvalido = motivo.length > 0 && motivo.length < 10
  const descricaoObrig = tipo === "outro" && descricao.trim().length === 0
  const podeEnviar =
    !enviando &&
    encomendaSelecionada != null &&
    motivo.length >= 10 &&
    !(tipo === "outro" && descricao.trim().length === 0)

  // =========================================================================
  // RENDER — SUCESSO
  // =========================================================================

  if (estado === "success") {
    return (
      <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
        <Paper
          variant="outlined"
          sx={{ p: 4, textAlign: "center" }}
          data-testid="resultado-sucesso-ocorrencia"
        >
          <CheckCircleRounded
            sx={{ fontSize: 64, color: "success.main", mb: 2 }}
          />
          <Typography variant="h5" fontWeight={700} gutterBottom>
            Ocorrência registrada com sucesso
          </Typography>
          <Stack spacing={1} mt={2}>
            <Typography variant="body2" color="text.secondary">
              Encomenda: {encomendaSelecionada?.codigoRastreamento ?? `#${encomendaSelecionada?.id}`}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Tipo:{" "}
              {OCORRENCIA_TIPOS.find((t) => t.value === tipo)?.label ?? tipo}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Motivo: {motivo}
            </Typography>
          </Stack>
          <Button
            variant="contained"
            onClick={handleNovaOcorrencia}
            sx={{ mt: 3 }}
            data-testid="botao-nova-ocorrencia"
          >
            Registrar nova ocorrência
          </Button>
        </Paper>
      </Box>
    )
  }

  if (estado === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
        <Alert severity="error" data-testid="alerta-erro-ocorrencia">
          {erroMsg}
        </Alert>
        <Button
          variant="outlined"
          onClick={handleNovaOcorrencia}
          sx={{ mt: 2 }}
        >
          Tentar novamente
        </Button>
      </Box>
    )
  }

  // =========================================================================
  // RENDER — FORMULÁRIO
  // =========================================================================

  return (
    <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <WarningAmberRounded sx={{ fontSize: 32, color: "error.main" }} />
        <Box flex={1}>
          <Typography variant="h4" fontWeight={700}>
            Ocorrência / Devolução
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Registre desvios, devoluções e anomalias de encomendas
          </Typography>
        </Box>
      </Stack>

      {/* Alerta geral */}
      {erroMsg && (
        <Alert severity="error" sx={{ mb: 3 }} data-testid="alerta-geral">
          {erroMsg}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={3}>
          {/* ---- Seleção de encomenda ---- */}
          <Autocomplete
            options={opcoesEncomenda}
            value={encomendaSelecionada}
            onChange={(_, v) => setEncomendaSelecionada(v)}
            loading={buscandoEncomenda}
            getOptionLabel={(opt: EncomendaSelecao) =>
              [
                opt.codigoRastreamento ?? `#${opt.id}`,
                opt.unidadeLabel ?? "",
                opt.transportadoraNome ?? "",
              ]
                .filter(Boolean)
                .join(" — ")
            }
            isOptionEqualToValue={(opt, val) => opt.id === val.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Buscar encomenda"
                placeholder="Código, ID ou unidade"
                fullWidth
                required
                helperText={
                  opcoesEncomenda.length === 0 && buscaEncomenda.length >= 2
                    ? "Nenhuma encomenda encontrada com esse critério"
                    : ""
                }
              />
            )}
            renderOption={(props, opt) => (
              <li {...props} key={opt.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" fontWeight={600}>
                    #{opt.id}
                  </Typography>
                  {opt.codigoRastreamento && (
                    <Typography variant="body2" color="text.secondary">
                      {opt.codigoRastreamento}
                    </Typography>
                  )}
                  {opt.unidadeLabel && (
                    <Typography variant="body2" color="text.secondary">
                      — {opt.unidadeLabel}
                    </Typography>
                  )}
                </Stack>
              </li>
            )}
          />

          {/* ---- Tipo de ocorrência ---- */}
          <FormControl fullWidth>
            <InputLabel id="label-tipo-ocorrencia">Tipo de Ocorrência</InputLabel>
            <Select
              labelId="label-tipo-ocorrencia"
              value={tipo}
              label="Tipo de Ocorrência"
              onChange={(e) => setTipo(e.target.value as OcorrenciaTipo)}
              data-testid="campo-tipo-ocorrencia"
            >
              {OCORRENCIA_TIPOS.map((t) => (
                <MenuItem key={t.value} value={t.value}>
                  {t.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* ---- Motivo ---- */}
          <TextField
            label="Motivo"
            multiline
            minRows={3}
            fullWidth
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
            error={motivoInvalido}
            helperText={`${motivo.length}/10 caracteres mínimos` + (tipo === "outro" ? " · Descrição obrigatória abaixo" : "")}
            data-testid="campo-motivo"
          />

          {/* ---- Motivos sugeridos (chips clicáveis) ---- */}
          {motivosSugeridos[tipo].length > 0 && (
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {motivosSugeridos[tipo].map((s, i) => (
                <Chip
                  key={i}
                  label={s.length > 35 ? `${s.slice(0, 35)}…` : s}
                  variant="outlined"
                  onClick={() => setMotivo(s)}
                  sx={{ fontSize: "0.75rem" }}
                  data-testid={`chip-motivo-sugerido-${i}`}
                />
              ))}
            </Stack>
          )}

          {/* ---- Descrição (condicional) ---- */}
          {tipo === "outro" && (
            <TextField
              label="Descrição"
              multiline
              minRows={3}
              fullWidth
              placeholder="Descreva detalhadamente o motivo da ocorrência"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              required={tipo === "outro"}
              error={descricaoObrig}
              helperText={
                descricaoObrig
                  ? "Obrigatória quando tipo for 'Outro'"
                  : `${descricao.trim().length} caracteres`
              }
              data-testid="campo-descricao"
            />
          )}

          {/* ---- Foto/Evidência (opcional) ---- */}
          <Box>
            <Typography variant="subtitle2" mb={1}>
              Foto / Evidência <span style={{ color: "text.disabled" }}>(opcional)</span>
            </Typography>
            {fotoUrl ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <img
                  src={fotoUrl}
                  alt="Evidência"
                  style={{
                    maxWidth: 200,
                    maxHeight: 150,
                    borderRadius: 8,
                    objectFit: "cover",
                  }}
                />
                <IconButton onClick={handleRemoverFoto} color="error">
                  <CloseRounded />
                </IconButton>
              </Stack>
            ) : (
              <Stack direction="row" spacing={1}>
                <Button
                  variant="outlined"
                  startIcon={<PhotoCameraRounded />}
                  onClick={() => handleCapturaFoto("camera")}
                  data-testid="botao-capturar-foto"
                >
                  Câmera
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<DescriptionRounded />}
                  onClick={() => handleCapturaFoto("file")}
                  data-testid="botao-carregar-foto"
                >
                  Arquivo
                </Button>
              </Stack>
            )}
          </Box>
        </Stack>

        {/* ---- Botão enviar ---- */}
        <Box sx={{ mt: 3, display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="contained"
            color="error"
            startIcon={<DeleteSweepRounded />}
            onClick={enviando ? undefined : enviarOcorrencia}
            disabled={!podeEnviar || enviando}
            data-testid="botao-registrar-ocorrencia"
          >
            {enviando ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              "Registrar Ocorrência e Cancelar Encomenda"
            )}
          </Button>
        </Box>
      </Paper>
    </Box>
  )
}

export const componentId = "taqui-ocorrencia-devolucao"
