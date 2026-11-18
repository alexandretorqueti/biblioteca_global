import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControl, InputLabel, MenuItem, Paper, Select, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material"
import { DeleteOutlineRounded, RefreshRounded, WhatsApp } from "@mui/icons-material"
import { ProjectsClient, WhatsappChannelsClient } from "@biblioteca-global/api-client"
import type { TenantCanalWhatsapp, TenantCanalWhatsappEstado, Projeto } from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "biblioteca-global-canais-whatsapp"

type Pairing = { tenantId: number; tenantName: string; accountId: string; qr: string; expiresAt: string }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Não foi possível concluir a operação."
}

export function formatarEstado(estado: TenantCanalWhatsappEstado): string {
  return { pareando: "Pareando", ativo: "Ativo", expirado: "Expirado", removido: "Removido" }[estado]
}

export function formatarData(timestamp: string | null): string {
  if (!timestamp) return "—"
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR")
}

export default function WhatsAppChannelsScreen(): ReactNode {
  const bundle = useApi()
  const whatsapp = useMemo(() => bundle ? new WhatsappChannelsClient(bundle.http) : undefined, [bundle])
  const projects = useMemo(() => bundle ? new ProjectsClient(bundle.http) : undefined, [bundle])
  const [items, setItems] = useState<TenantCanalWhatsapp[]>([])
  const [projectItems, setProjectItems] = useState<Projeto[]>([])
  const [selectedTenant, setSelectedTenant] = useState("")
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [pairingState, setPairingState] = useState<TenantCanalWhatsappEstado>("pareando")
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!whatsapp || !projects) return
    setLoading(true); setError(null)
    try {
      const page = await projects.list()
      const activeProjects = page.items.filter((project) => project.ativo)
      const lists = await Promise.all(activeProjects.map((project) => whatsapp.list(project.id)))
      setProjectItems(activeProjects)
      setItems(lists.flat())
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }, [projects, whatsapp])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!pairing || !whatsapp || pairingState === "ativo" || pairingState === "expirado" || pairingState === "removido") return
    let cancelled = false
    const check = async () => {
      try {
        const status = await whatsapp.getPairingStatus(pairing.tenantId, pairing.accountId)
        if (cancelled) return
        setItems((current) => current.map((item) => item.tenantId === pairing.tenantId
          ? { ...item, estado: status.estado, numero: status.numero, agentId: status.agentId, ultimoStatusEm: status.ultimoStatusEm, updatedAt: new Date().toISOString() }
          : item))
        if (status.estado === "ativo" || status.estado === "expirado" || status.estado === "removido") {
          setPairingState(status.estado)
        }
      } catch (cause) { if (!cancelled) setError(errorMessage(cause)) }
    }
    void check()
    const timer = window.setInterval(() => { void check() }, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [load, pairing, pairingState, whatsapp])

  const tenantName = (tenantId: number) => projectItems.find((project) => project.id === tenantId)?.nome ?? `Tenant #${tenantId}`

  const startPairing = async () => {
    if (!whatsapp || !selectedTenant) return
    const project = projectItems.find((item) => String(item.id) === selectedTenant)
    if (!project) return
    setWorking(true); setError(null)
    try {
      const result = await whatsapp.startPairing(project.id, project.slug)
      setPairingState("pareando")
      setPairing({ tenantId: project.id, tenantName: project.nome, accountId: result.accountId, qr: result.qr, expiresAt: result.expiresAt })
      await load()
    } catch (cause) { setError(errorMessage(cause)) } finally { setWorking(false) }
  }

  const remove = async (item: TenantCanalWhatsapp) => {
    if (!whatsapp || !window.confirm(`Remover o vínculo WhatsApp de ${tenantName(item.tenantId)}?`)) return
    setError(null)
    try { await whatsapp.remove(item.tenantId, item.accountId); await load() } catch (cause) { setError(errorMessage(cause)) }
  }

  return (
    <Stack spacing={2} data-testid="whatsapp-channels-screen">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} spacing={1}>
        <Box><Typography variant="h4" component="h1" fontWeight={700}>Conectar WhatsApp</Typography><Typography color="text.secondary">Gerencie os canais WhatsApp vinculados aos tenants.</Typography></Box>
        <Button startIcon={<RefreshRounded />} onClick={() => void load()} disabled={loading}>Atualizar</Button>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      <Paper variant="outlined"><Stack direction={{ xs: "column", sm: "row" }} spacing={1} p={2}>
        <FormControl fullWidth size="small"><InputLabel>Tenant</InputLabel><Select label="Tenant" value={selectedTenant} onChange={(event) => setSelectedTenant(String(event.target.value))}><MenuItem value=""><em>Selecione</em></MenuItem>{projectItems.map((project) => <MenuItem key={project.id} value={String(project.id)}>{project.nome} ({project.slug})</MenuItem>)}</Select></FormControl>
        <Button variant="contained" startIcon={<WhatsApp />} onClick={() => void startPairing()} disabled={!selectedTenant || working}>{working ? <CircularProgress size={20} /> : "Conectar WhatsApp"}</Button>
      </Stack></Paper>
      <Paper variant="outlined" sx={{ overflow: "auto" }}>{loading ? <Box sx={{ display: "grid", placeItems: "center", p: 5 }}><CircularProgress /></Box> : <Table size="small"><TableHead><TableRow><TableCell>Tenant</TableCell><TableCell>Número</TableCell><TableCell>Estado</TableCell><TableCell>Agent ID</TableCell><TableCell>Atualizado em</TableCell><TableCell align="right">Ação</TableCell></TableRow></TableHead><TableBody>{items.map((item) => <TableRow hover key={`${item.tenantId}-${item.accountId}`}><TableCell>{tenantName(item.tenantId)}</TableCell><TableCell>{item.numero ?? "—"}</TableCell><TableCell>{formatarEstado(item.estado)}</TableCell><TableCell>{item.agentId ?? "—"}</TableCell><TableCell>{formatarData(item.updatedAt)}</TableCell><TableCell align="right"><Button color="error" size="small" startIcon={<DeleteOutlineRounded />} onClick={() => void remove(item)}>Remover</Button></TableCell></TableRow>)}{items.length === 0 && <TableRow><TableCell colSpan={6} align="center">Nenhum vínculo WhatsApp encontrado.</TableCell></TableRow>}</TableBody></Table>}</Paper>

      <Dialog open={Boolean(pairing)} onClose={() => !working && setPairing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Parear WhatsApp — {pairing?.tenantName}</DialogTitle><DialogContent><Stack spacing={2} alignItems="center" pt={1}>
          {pairing && <Box component="img" src={pairing.qr} alt="QR Code para pareamento do WhatsApp" sx={{ width: 280, height: 280, imageRendering: "pixelated" }} />}
          <Typography>QR válido até {formatarData(pairing?.expiresAt ?? null)}</Typography>
          <Typography color="text.secondary">Estado: {pairing ? formatarEstado(pairingState) : "—"}</Typography>
        </Stack></DialogContent><DialogActions><Button onClick={() => void startPairing()} disabled={working || !selectedTenant}>Gerar novo QR</Button><Button onClick={() => setPairing(null)}>Fechar</Button></DialogActions>
      </Dialog>
    </Stack>
  )
}
