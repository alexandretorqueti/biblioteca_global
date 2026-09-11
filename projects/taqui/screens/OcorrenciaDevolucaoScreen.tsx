/**
 * Tela de ação rápida para registrar ocorrências e devoluções.
 *
 * A encomenda é localizada pelo endpoint do painel (já isolado pelo token) e
 * o POST envia somente o encomendaId e os dados da ocorrência. O condomínio e
 * o funcionário responsável nunca vêm do formulário.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
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
  Inventory2Rounded,
  SearchRounded,
  WarningAmberRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

export const componentId = "taqui-ocorrencia-devolucao"

type StatusEncomenda = "pendente" | "pronta_retirada" | "entregue" | "cancelada"
type TipoOcorrencia =
  | "devolucao_transportadora"
  | "extravio"
  | "recusada"
  | "endereco_incorreto"
  | "outro"

interface EncomendaItem {
  id: number
  status: StatusEncomenda
  fotoUrl: string | null
  codigoRastreamento: string | null
  unidadeLabel: string | null
  transportadoraNome: string | null
  chegadaEm: string
}

interface ResultadoRegistro {
  encomenda: { id: number; status: string; atualizado: boolean }
  notificacao: { enviada: boolean; totalMoradores: number; erro?: string }
}

const TIPOS: Array<{ value: TipoOcorrencia; label: string }> = [
  { value: "devolucao_transportadora", label: "Devolução pela transportadora" },
  { value: "extravio", label: "Extravio" },
  { value: "recusada", label: "Recusada pelo morador" },
  { value: "endereco_incorreto", label: "Endereço incorreto" },
  { value: "outro", label: "Outro" },
]

function statusLabel(status: StatusEncomenda): string {
  return {
    pendente: "Aguardando confirmação",
    pronta_retirada: "Pronta para retirada",
    entregue: "Entregue",
    cancelada: "Cancelada",
  }[status]
}

function formatarData(iso: string): string {
  const data = new Date(iso)
  return Number.isNaN(data.getTime()) ? iso : data.toLocaleString("pt-BR")
}

export default function OcorrenciaDevolucaoScreen(): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()
  const [busca, setBusca] = useState("")
  const [resultados, setResultados] = useState<EncomendaItem[]>([])
  const [selecionada, setSelecionada] = useState<EncomendaItem | null>(null)
  const [tipo, setTipo] = useState<TipoOcorrencia>("devolucao_transportadora")
  const [motivo, setMotivo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [fotoEvidenciaUrl, setFotoEvidenciaUrl] = useState("")
  const [observacoes, setObservacoes] = useState("")
  const [devolvidaTransportadora, setDevolvidaTransportadora] = useState(false)
  const [carregando, setCarregando] = useState(false)
  const [registrando, setRegistrando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [sucesso, setSucesso] = useState<ResultadoRegistro | null>(null)

  const buscar = useCallback(async () => {
    if (!bundle || !projeto || !busca.trim() || selecionada) {
      setResultados([])
      return
    }
    setCarregando(true)
    setErro(null)
    try {
      const result = await bundle.http.request<{ itens: EncomendaItem[] }>(
        "GET",
        `/${projeto.slug}/painel-portaria/encomendas`,
        { query: { busca: busca.trim(), limit: "20" }, auth: "access" },
      )
      setResultados(result.itens ?? [])
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível buscar a encomenda.")
      setResultados([])
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto, busca, selecionada])

  useEffect(() => {
    const timer = window.setTimeout(() => void buscar(), 300)
    return () => window.clearTimeout(timer)
  }, [buscar])

  const escolher = useCallback((item: EncomendaItem) => {
    setSelecionada(item)
    setResultados([])
    setBusca(item.codigoRastreamento ?? `Encomenda #${item.id}`)
    setErro(null)
    setSucesso(null)
  }, [])

  const limpar = useCallback(() => {
    setSelecionada(null)
    setBusca("")
    setTipo("devolucao_transportadora")
    setMotivo("")
    setDescricao("")
    setFotoEvidenciaUrl("")
    setObservacoes("")
    setDevolvidaTransportadora(false)
    setSucesso(null)
    setErro(null)
  }, [])

  const registrar = useCallback(async () => {
    if (!bundle || !projeto || !selecionada) return
    setRegistrando(true)
    setErro(null)
    try {
      const result = await bundle.http.request<ResultadoRegistro>(
        "POST",
        `/${projeto.slug}/ocorrencias`,
        {
          body: {
            encomendaId: selecionada.id,
            tipo,
            motivo: motivo.trim(),
            descricao: descricao.trim() || undefined,
            fotoEvidenciaUrl: fotoEvidenciaUrl.trim() || undefined,
            observacoes: observacoes.trim() || undefined,
            devolvidaTransportadora,
          },
          auth: "access",
        },
      )
      setSucesso(result)
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível registrar a ocorrência.")
    } finally {
      setRegistrando(false)
    }
  }, [bundle, projeto, selecionada, tipo, motivo, descricao, fotoEvidenciaUrl, observacoes, devolvidaTransportadora])

  const statusBloqueado = selecionada !== null && (selecionada.status === "entregue" || selecionada.status === "cancelada")
  const formularioValido = Boolean(
    selecionada && !statusBloqueado && motivo.trim().length >= 10 &&
      (tipo !== "outro" || descricao.trim().length >= 10),
  )

  return (
    <Box sx={{ p: 3, maxWidth: 900, mx: "auto" }}>
      <Stack direction="row" spacing={2} alignItems="center" mb={3}>
        <WarningAmberRounded sx={{ fontSize: 34, color: "warning.main" }} />
        <Box>
          <Typography variant="h4" fontWeight={700}>Ocorrência / Devolução</Typography>
          <Typography variant="body2" color="text.secondary">
            Registre o desvio com motivo e evidência para manter o histórico auditável.
          </Typography>
        </Box>
      </Stack>

      {sucesso ? (
        <Paper variant="outlined" sx={{ p: 3 }} data-testid="sucesso-ocorrencia">
          <Alert severity="success" icon={<CheckCircleRounded />}>
            Ocorrência registrada para a encomenda #{sucesso.encomenda.id}.
            {sucesso.encomenda.atualizado && " A encomenda foi cancelada."}
          </Alert>
          <Typography variant="body2" sx={{ mt: 2 }}>
            {sucesso.notificacao.enviada
              ? `${sucesso.notificacao.totalMoradores} morador(es) notificado(s).`
              : "Nenhuma notificação foi enviada."}
          </Typography>
          <Button variant="contained" sx={{ mt: 3 }} onClick={limpar} data-testid="botao-nova-ocorrencia">
            Registrar outra ocorrência
          </Button>
        </Paper>
      ) : (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <TextField
              fullWidth
              label="Localizar encomenda"
              placeholder="Código de rastreamento, ID ou unidade"
              value={busca}
              onChange={(event) => { setBusca(event.target.value); if (selecionada) setSelecionada(null) }}
              slotProps={{ input: { startAdornment: <SearchRounded sx={{ mr: 1, color: "text.secondary" }} /> } }}
              data-testid="campo-busca-encomenda"
            />
            {carregando && <CircularProgress size={22} sx={{ mt: 2 }} />}
            {resultados.length > 0 && (
              <Stack spacing={1} sx={{ mt: 2 }} data-testid="resultados-encomendas">
                {resultados.map((item) => (
                  <Paper key={item.id} variant="outlined" sx={{ p: 1.5, cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }} onClick={() => escolher(item)}>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Avatar variant="rounded" src={item.fotoUrl ?? undefined}><Inventory2Rounded /></Avatar>
                      <Box flex={1}>
                        <Typography fontWeight={600}>{item.unidadeLabel ?? `Encomenda #${item.id}`}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          #{item.id}{item.codigoRastreamento ? ` · ${item.codigoRastreamento}` : ""} · {formatarData(item.chegadaEm)}
                        </Typography>
                      </Box>
                      <Chip label={statusLabel(item.status)} color={item.status === "cancelada" ? "error" : item.status === "entregue" ? "default" : "warning"} size="small" />
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Paper>

          {selecionada && (
            <Paper variant="outlined" sx={{ p: 2.5 }} data-testid="formulario-ocorrencia">
              <Stack direction="row" spacing={2} alignItems="center" mb={2}>
                <Avatar variant="rounded" src={selecionada.fotoUrl ?? undefined}><Inventory2Rounded /></Avatar>
                <Box flex={1}>
                  <Typography variant="h6">{selecionada.unidadeLabel ?? `Encomenda #${selecionada.id}`}</Typography>
                  <Typography variant="body2" color="text.secondary">Encomenda #{selecionada.id}{selecionada.transportadoraNome ? ` · ${selecionada.transportadoraNome}` : ""}</Typography>
                </Box>
                <Chip label={statusLabel(selecionada.status)} color={statusBloqueado ? "error" : "warning"} />
              </Stack>
              {statusBloqueado ? (
                <Alert severity="error" data-testid="ocorrencia-bloqueada">
                  Esta encomenda está {selecionada.status === "entregue" ? "entregue" : "cancelada"} e não aceita nova transição.
                </Alert>
              ) : (
                <Stack spacing={2}>
                  <FormControl fullWidth>
                    <InputLabel>Tipo de ocorrência</InputLabel>
                    <Select value={tipo} label="Tipo de ocorrência" onChange={(event) => setTipo(event.target.value as TipoOcorrencia)} data-testid="select-tipo-ocorrencia">
                      {TIPOS.map((opcao) => <MenuItem key={opcao.value} value={opcao.value}>{opcao.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <TextField label="Motivo" value={motivo} onChange={(event) => setMotivo(event.target.value)} required fullWidth multiline rows={3} helperText={`${motivo.length}/2000 — mínimo 10 caracteres`} slotProps={{ htmlInput: { maxLength: 2000 } }} data-testid="campo-motivo-ocorrencia" />
                  {tipo === "outro" && <TextField label="Descrição" value={descricao} onChange={(event) => setDescricao(event.target.value)} required fullWidth multiline rows={3} helperText="Obrigatória para o tipo Outro (mínimo 10 caracteres)" data-testid="campo-descricao-ocorrencia" />}
                  <TextField label="URL da foto/evidência (opcional)" value={fotoEvidenciaUrl} onChange={(event) => setFotoEvidenciaUrl(event.target.value)} fullWidth data-testid="campo-foto-evidencia" />
                  <TextField label="Observações (opcional)" value={observacoes} onChange={(event) => setObservacoes(event.target.value)} fullWidth multiline rows={2} data-testid="campo-observacoes-ocorrencia" />
                  <FormControlLabel control={<Checkbox checked={devolvidaTransportadora} onChange={(event) => setDevolvidaTransportadora(event.target.checked)} />} label="Encomenda devolvida à transportadora" />
                  {erro && <Alert severity="error">{erro}</Alert>}
                  <Button variant="contained" color="warning" onClick={() => void registrar()} disabled={!formularioValido || registrando} startIcon={registrando ? <CircularProgress size={18} /> : <CheckCircleRounded />} data-testid="botao-registrar-ocorrencia">
                    {registrando ? "Registrando..." : "Registrar ocorrência"}
                  </Button>
                </Stack>
              )}
            </Paper>
          )}
          {!selecionada && erro && <Alert severity="error">{erro}</Alert>}
        </Stack>
      )}
    </Box>
  )
}
