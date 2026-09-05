import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, List, ListItemButton,
  ListItemText, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material"
import { PreviewRounded, PublishRounded, SaveRounded, RestoreRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

type PromptVersion = { id: number; versao: number; texto: string; contratoVersaoId?: number | null; motivo?: string | null; autor?: string | null; createdAt: string }
type Prompt = {
  id: number; chave: string; tipoAgente: string; situacao: string; titulo: string;
  descricao?: string | null; status: "draft" | "active" | "inactive";
  versaoAtivaId?: number | null; allowedMarkers: string[]; versions: PromptVersion[]
}
type Mask = { id: number; nome: string; descricao: string; origem: string; exemplo?: string | null; obrigatoria: boolean }
type ContractVersion = { id: number; versao: number; schemaJson: unknown; exemploJson: unknown; instrucoes: string; autor?: string | null; createdAt: string }
type Contract = { id: number; chave: string; titulo: string; status: string; versaoAtivaId?: number | null; versions: ContractVersion[] }
type Catalog = { prompts: Prompt[]; masks: Mask[]; contracts: Contract[] }

export default function PromptsScreen(): ReactNode {
  const api = useApi()
  const [catalog, setCatalog] = useState<Catalog>({ prompts: [], masks: [], contracts: [] })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [text, setText] = useState("")
  const [reason, setReason] = useState("")
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [contractVersionId, setContractVersionId] = useState<number | "">("")
  const [selectedContractId, setSelectedContractId] = useState<number | null>(null)
  const [contractSchema, setContractSchema] = useState("")
  const [contractExample, setContractExample] = useState("")
  const [contractInstructions, setContractInstructions] = useState("")

  const selected = useMemo(() => catalog.prompts.find((prompt) => prompt.id === selectedId) ?? null, [catalog, selectedId])
  const masks = useMemo(() => catalog.masks.filter((mask) => selected?.allowedMarkers.includes(mask.nome)), [catalog, selected])

  const load = useCallback(async (preferred?: number) => {
    if (!api) return
    setLoading(true)
    try {
      const data = await api.http.request<Catalog>("GET", "/gerenteagentes/prompts", { auth: "access" })
      setCatalog(data)
      const id = preferred ?? selectedId ?? data.prompts[0]?.id ?? null
      setSelectedId(id)
      const prompt = data.prompts.find((item) => item.id === id)
      const current = prompt?.versions.find((version) => version.id === prompt.versaoAtivaId) ?? prompt?.versions[0]
      setText(current?.texto ?? "")
      setContractVersionId(current?.contratoVersaoId ?? "")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar prompts")
    } finally { setLoading(false) }
  }, [api, selectedId])

  useEffect(() => { void load() }, [api])

  const choose = (prompt: Prompt) => {
    setSelectedId(prompt.id)
    const current = prompt.versions.find((version) => version.id === prompt.versaoAtivaId) ?? prompt.versions[0]
    setText(current?.texto ?? "")
    setContractVersionId(current?.contratoVersaoId ?? "")
    setPreview(null); setError(null); setNotice(null)
  }

  const save = async () => {
    if (!api || !selected) return
    setBusy(true); setError(null)
    try {
      const created = await api.http.request<{ id: number; versao: number }>("POST", `/gerenteagentes/prompts/${selected.id}/versions`, {
        auth: "access", body: { texto: text, motivo: reason || "Ajuste administrativo", contratoVersaoId: contractVersionId || undefined },
      })
      setNotice(`Rascunho v${created.versao} salvo. Revise a prévia antes de publicar.`)
      await load(selected.id)
      setText(text)
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar") } finally { setBusy(false) }
  }

  const chooseContract = (contract: Contract) => {
    setSelectedContractId(contract.id)
    const version = contract.versions.find((item) => item.id === contract.versaoAtivaId) ?? contract.versions[0]
    setContractSchema(JSON.stringify(version?.schemaJson ?? {}, null, 2)); setContractExample(JSON.stringify(version?.exemploJson ?? {}, null, 2)); setContractInstructions(version?.instrucoes ?? "")
  }

  const saveContract = async () => {
    if (!api || !selectedContractId) return
    setBusy(true); setError(null)
    try {
      await api.http.request("POST", `/gerenteagentes/prompt-contracts/${selectedContractId}/versions`, { auth: "access", body: { schemaJson: JSON.parse(contractSchema), exemploJson: JSON.parse(contractExample), instrucoes: contractInstructions, motivo: reason || "Ajuste administrativo" } })
      setNotice("Nova versão do contrato salva."); await load(selectedId ?? undefined)
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar contrato") } finally { setBusy(false) }
  }

  const publish = async (versionId: number, restore = false) => {
    if (!api || !selected) return
    setBusy(true); setError(null)
    try {
      await api.http.request("POST", `/gerenteagentes/prompts/${selected.id}/publish/${versionId}`, { auth: "access" })
      setNotice(restore ? "Versão anterior restaurada e publicada." : "Versão publicada. Novas execuções já usarão este texto.")
      await load(selected.id)
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao publicar") } finally { setBusy(false) }
  }

  const renderPreview = async () => {
    if (!api || !selected) return
    setBusy(true); setError(null)
    try {
      const result = await api.http.request<{ rendered: string | null; validation: { ok: boolean; unknown: string[]; missing: string[] } }>(
        "POST", `/gerenteagentes/prompts/${selected.id}/preview`, { auth: "access", body: { texto: text } },
      )
      if (!result.validation.ok) throw new Error(`Máscaras inválidas: ${[...result.validation.unknown, ...result.validation.missing].join(", ")}`)
      setPreview(result.rendered)
    } catch (e) { setError(e instanceof Error ? e.message : "Falha na prévia") } finally { setBusy(false) }
  }

  if (loading) return <Box sx={{ display: "grid", placeItems: "center", minHeight: 300 }}><CircularProgress /></Box>
  return <Stack spacing={2} data-testid="prompts-screen">
    <Box><Typography variant="h4" fontWeight={700}>Prompts</Typography><Typography color="text.secondary">Edite, valide e publique os prompts usados pelo Motor.</Typography></Box>
    {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
    {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "300px minmax(0,1fr) 300px" }, gap: 2 }}>
      <Paper variant="outlined"><List dense>{catalog.prompts.map((prompt) => <ListItemButton key={prompt.id} selected={prompt.id === selectedId} onClick={() => choose(prompt)}><ListItemText primary={prompt.titulo} secondary={`${prompt.tipoAgente} · ${prompt.situacao}`} /><Chip size="small" label={prompt.status} color={prompt.status === "active" ? "success" : "default"} /></ListItemButton>)}</List></Paper>
      <Stack spacing={2}>
        <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}>
          <Typography variant="h6">{selected?.chave ?? "Selecione um prompt"}</Typography>
          <TextField multiline minRows={18} fullWidth label="Texto do prompt" value={text} onChange={(e) => setText(e.target.value)} />
          <TextField select fullWidth label="Versão do contrato de saída" value={contractVersionId} onChange={(e) => setContractVersionId(Number(e.target.value) || "")}><MenuItem value="">Sem contrato</MenuItem>{catalog.contracts.flatMap((contract) => contract.versions.map((version) => <MenuItem key={version.id} value={version.id}>{contract.titulo} · v{version.versao}{version.id === contract.versaoAtivaId ? " (ativa)" : ""}</MenuItem>))}</TextField>
          <TextField fullWidth label="Motivo da alteração" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Stack direction="row" spacing={1}><Button variant="contained" startIcon={<SaveRounded />} disabled={busy || !text.trim()} onClick={() => void save()}>Salvar rascunho</Button><Button startIcon={<PreviewRounded />} disabled={busy || !text.trim()} onClick={() => void renderPreview()}>Pré-visualizar</Button></Stack>
        </Stack></Paper>
        {preview && <Paper variant="outlined" sx={{ p: 2 }}><Typography variant="subtitle1" fontWeight={700}>Prévia renderizada</Typography><Box component="pre" sx={{ whiteSpace: "pre-wrap", overflow: "auto" }}>{preview}</Box></Paper>}
        <Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h6">Histórico de versões</Typography><Stack divider={<Divider />} spacing={1}>{selected?.versions.map((version) => <Box key={version.id} sx={{ py: 1 }}><Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography fontWeight={600}>Versão {version.versao}{version.id === selected.versaoAtivaId ? " · ativa" : ""}</Typography><Typography variant="caption">{version.autor || "sistema"} · {new Date(version.createdAt).toLocaleString("pt-BR")}</Typography></Box><Stack direction="row"><Button size="small" onClick={() => setText(version.texto)}>Carregar</Button>{version.id === selected.versaoAtivaId ? null : <Button size="small" startIcon={selected.versaoAtivaId ? <RestoreRounded /> : <PublishRounded />} onClick={() => void publish(version.id, Boolean(selected.versaoAtivaId))}>{selected.versaoAtivaId ? "Restaurar" : "Publicar"}</Button>}</Stack></Stack></Box>)}</Stack></Paper>
      </Stack>
      <Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h6">Máscaras disponíveis</Typography><Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Clique para inserir no cursor.</Typography><Stack spacing={1}>{masks.map((mask) => <Box key={mask.id}><Button size="small" variant="outlined" onClick={() => setText((current) => current + mask.nome)}>{mask.nome}</Button><Typography variant="caption" display="block">{mask.descricao}</Typography></Box>)}</Stack></Paper>
    </Box>
    <Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h5" fontWeight={700}>Contratos de saída versionados</Typography><Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ my: 2 }}>{catalog.contracts.map((contract) => <Button key={contract.id} variant={selectedContractId === contract.id ? "contained" : "outlined"} onClick={() => chooseContract(contract)}>{contract.titulo}</Button>)}</Stack>{selectedContractId && <Stack spacing={2}><TextField multiline minRows={8} label="JSON Schema" value={contractSchema} onChange={(e) => setContractSchema(e.target.value)} /><TextField multiline minRows={4} label="Exemplo JSON" value={contractExample} onChange={(e) => setContractExample(e.target.value)} /><TextField multiline minRows={4} label="Instruções injetadas no prompt" value={contractInstructions} onChange={(e) => setContractInstructions(e.target.value)} /><Button variant="contained" disabled={busy} onClick={() => void saveContract()}>Salvar nova versão do contrato</Button><Stack direction="row" spacing={1}>{catalog.contracts.find((item) => item.id === selectedContractId)?.versions.map((version) => <Button key={version.id} size="small" onClick={() => void api?.http.request("POST", `/gerenteagentes/prompt-contracts/${selectedContractId}/publish/${version.id}`, { auth: "access" }).then(() => load(selectedId ?? undefined))}>Publicar v{version.versao}</Button>)}</Stack></Stack>}</Paper>
  </Stack>
}
