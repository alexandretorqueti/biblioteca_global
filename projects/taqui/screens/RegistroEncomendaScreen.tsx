/** Tela de registro rápido de encomendas na triagem/portaria. */
import { useCallback, useEffect, useRef, useState, type ReactNode, type ChangeEvent } from "react"
import {
  Alert, Box, Button, CircularProgress, FormControl, InputLabel, MenuItem,
  Paper, Select, Stack, TextField, Typography,
} from "@mui/material"
import { CameraAltRounded, Inventory2Rounded, QrCodeScannerRounded, SaveRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

interface Unidade { id: number; label: string | null; moradores?: Array<{ id: number; nome: string }> }
interface Transportadora { id: number; nome: string; frequencia?: number }
interface Funcionario { id: number; nome: string; funcao: string; ativo?: boolean }

type Detector = { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>> }

export default function RegistroEncomendaScreen(): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [unidades, setUnidades] = useState<Unidade[]>([])
  const [transportadoras, setTransportadoras] = useState<Transportadora[]>([])
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([])
  const [unidadeId, setUnidadeId] = useState("")
  const [transportadoraId, setTransportadoraId] = useState("")
  const [registradoPorId, setRegistradoPorId] = useState("")
  const [codigo, setCodigo] = useState("")
  const [observacoes, setObservacoes] = useState("")
  const [fotoUrl, setFotoUrl] = useState<string | null>(null)
  const [cameraAtiva, setCameraAtiva] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [mensagem, setMensagem] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!bundle || !projeto) return
    const carregar = async () => {
      try {
        const [u, t, f] = await Promise.all([
          bundle.http.request<Unidade[]>("GET", `/${projeto.slug}/encomendas-registro/unidades`, { query: { limit: "200", ativo: "true" }, auth: "access" }),
          bundle.http.request<Transportadora[]>("GET", `/${projeto.slug}/encomendas-registro/transportadoras`, { query: { limit: "200" }, auth: "access" }),
          bundle.http.request<{ items: Funcionario[] }>("GET", `/${projeto.slug}/funcionarios`, { query: { pageSize: 200 }, auth: "access" }),
        ])
        setUnidades(Array.isArray(u) ? u : [])
        setTransportadoras(Array.isArray(t) ? t : [])
        setFuncionarios((f.items ?? []).filter((item) => item.ativo !== false))
      } catch (cause) {
        setErro(cause instanceof Error ? cause.message : "Não foi possível carregar os dados da triagem.")
      }
    }
    void carregar()
  }, [bundle, projeto])

  const selecionarFoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFotoUrl(URL.createObjectURL(file))
  }

  const alternarCamera = useCallback(async () => {
    if (cameraAtiva) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setCameraAtiva(false)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErro("A câmera não está disponível neste navegador.")
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCameraAtiva(true)
    } catch {
      setErro("Não foi possível acessar a câmera. Você ainda pode anexar uma foto.")
    }
  }, [cameraAtiva])

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), [])

  const lerCodigo = async () => {
    const detector = (window as unknown as { BarcodeDetector?: new (options?: { formats?: string[] }) => Detector }).BarcodeDetector
    const video = videoRef.current
    if (!detector || !video) {
      setErro("A leitura automática não é suportada neste navegador; digite o código manualmente.")
      return
    }
    try {
      const encontrados = await new detector({ formats: ["qr_code", "code_128", "ean_13", "ean_8"] }).detect(video)
      const valor = encontrados[0]?.rawValue
      if (valor) setCodigo(valor)
      else setErro("Nenhum código foi encontrado. Aponte a câmera para o código e tente novamente.")
    } catch {
      setErro("Não foi possível ler o código. Tente novamente ou digite-o manualmente.")
    }
  }

  const registrar = async () => {
    if (!bundle || !projeto || !unidadeId || !registradoPorId) {
      setErro("Selecione a unidade e o funcionário responsável pelo registro.")
      return
    }
    setSalvando(true); setErro(null); setMensagem(null)
    try {
      await bundle.http.request("POST", `/${projeto.slug}/encomendas-registro`, {
        auth: "access",
        body: {
          unidadeId: Number(unidadeId),
          registradoPorId: Number(registradoPorId),
          transportadoraId: transportadoraId ? Number(transportadoraId) : null,
          codigoRastreamento: codigo.trim() || null,
          fotoUrl,
          observacoes: observacoes.trim() || null,
        },
      })
      setMensagem("Encomenda registrada. O morador foi notificado.")
      setUnidadeId(""); setTransportadoraId(""); setCodigo(""); setObservacoes(""); setFotoUrl(null)
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : "Não foi possível registrar a encomenda.")
    } finally { setSalvando(false) }
  }

  return <Box sx={{ p: 3, maxWidth: 760, mx: "auto" }} data-testid="registro-encomenda-screen">
    <Stack direction="row" spacing={1} alignItems="center" mb={3}><Inventory2Rounded color="primary" /><Box><Typography variant="h4">Registrar Encomenda</Typography><Typography color="text.secondary">Registre a chegada e avise o morador.</Typography></Box></Stack>
    {erro && <Alert severity="error" onClose={() => setErro(null)} sx={{ mb: 2 }} data-testid="alerta-erro-registro">{erro}</Alert>}
    {mensagem && <Alert severity="success" sx={{ mb: 2 }} data-testid="sucesso-registro">{mensagem}</Alert>}
    <Paper variant="outlined" sx={{ p: 3 }}><Stack spacing={2}>
      <FormControl fullWidth required><InputLabel>Unidade</InputLabel><Select label="Unidade" value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)} inputProps={{ "data-testid": "select-unidade" }}><MenuItem value="">Selecione...</MenuItem>{unidades.map((u) => <MenuItem key={u.id} value={u.id}>{u.label ?? `Unidade #${u.id}`}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth><InputLabel>Loja / Transportadora</InputLabel><Select label="Loja / Transportadora" value={transportadoraId} onChange={(e) => setTransportadoraId(e.target.value)} inputProps={{ "data-testid": "select-transportadora" }}><MenuItem value="">Não informado</MenuItem>{transportadoras.map((t) => <MenuItem key={t.id} value={t.id}>{t.nome}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth required><InputLabel>Registrado por</InputLabel><Select label="Registrado por" value={registradoPorId} onChange={(e) => setRegistradoPorId(e.target.value)} inputProps={{ "data-testid": "select-funcionario" }}><MenuItem value="">Selecione...</MenuItem>{funcionarios.map((f) => <MenuItem key={f.id} value={f.id}>{f.nome}</MenuItem>)}</Select></FormControl>
      <TextField label="Código de barras / QR code" value={codigo} onChange={(e) => setCodigo(e.target.value)} fullWidth inputProps={{ "data-testid": "campo-codigo" }} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><Button variant="outlined" component="label" startIcon={<CameraAltRounded />} data-testid="input-foto">Adicionar foto<input hidden type="file" accept="image/*" capture="environment" onChange={selecionarFoto} /></Button><Button variant="outlined" onClick={() => void alternarCamera()} startIcon={<CameraAltRounded />} data-testid="botao-camera">{cameraAtiva ? "Desligar câmera" : "Usar câmera"}</Button><Button variant="outlined" onClick={() => void lerCodigo()} startIcon={<QrCodeScannerRounded />} disabled={!cameraAtiva} data-testid="botao-ler-codigo">Ler código</Button></Stack>
      {cameraAtiva && <Box component="video" ref={videoRef} autoPlay playsInline sx={{ width: "100%", maxHeight: 280, bgcolor: "#111", borderRadius: 1 }} data-testid="preview-camera" />}
      {fotoUrl && <Box component="img" src={fotoUrl} alt="Foto da encomenda" sx={{ width: "100%", maxHeight: 280, objectFit: "contain" }} data-testid="preview-foto" />}
      <TextField label="Observações" value={observacoes} onChange={(e) => setObservacoes(e.target.value)} multiline minRows={3} fullWidth inputProps={{ maxLength: 2000, "data-testid": "campo-observacoes" }} />
      <Button variant="contained" size="large" onClick={() => void registrar()} disabled={salvando} startIcon={salvando ? <CircularProgress size={18} /> : <SaveRounded />} data-testid="botao-registrar">{salvando ? "Registrando..." : "Registrar encomenda"}</Button>
    </Stack></Paper>
  </Box>
}
