import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControl, FormControlLabel, InputLabel, MenuItem, Paper, Select,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material"
import { AddRounded, DeleteOutlineRounded, EditRounded, LinkRounded, RefreshRounded } from "@mui/icons-material"
import { GlobalUsersClient, ProjectsClient, type GlobalUser, type GlobalUserDetail, type GlobalUserLink } from "@biblioteca-global/api-client"
import type { Perfil, Projeto } from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "biblioteca-global-usuarios-gerais"

const PERFIS: Array<{ value: Perfil; label: string }> = [
  { value: "admin", label: "Administrador" },
  { value: "gerente", label: "Gerente" },
  { value: "operador", label: "Operador" },
  { value: "visualizador", label: "Visualizador" },
]

interface FormState { nome: string; username: string; email: string; telefone: string; cpf: string; senhaInicial: string; ativo: boolean }
const FORM_VAZIO: FormState = { nome: "", username: "", email: "", telefone: "", cpf: "", senhaInicial: "", ativo: true }

function mensagemDeErro(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return "Não foi possível concluir a operação."
}

function projetoLabel(projeto: Projeto): string { return `${projeto.nome}${projeto.ativo ? "" : " (inativo)"}` }

export default function GlobalUsersScreen(): ReactNode {
  const bundle = useApi()
  const users = useMemo(() => bundle ? new GlobalUsersClient(bundle.http) : undefined, [bundle])
  const projects = useMemo(() => bundle ? new ProjectsClient(bundle.http) : undefined, [bundle])
  const [items, setItems] = useState<GlobalUser[]>([])
  const [projectItems, setProjectItems] = useState<Projeto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<GlobalUser | null>(null)
  const [form, setForm] = useState<FormState>(FORM_VAZIO)
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<GlobalUserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [linkProject, setLinkProject] = useState("")
  const [linkProfile, setLinkProfile] = useState<Perfil | "">("")
  const [linkSaving, setLinkSaving] = useState(false)

  const load = useCallback(async () => {
    if (!users || !projects) return
    setLoading(true); setError(null)
    try {
      const [userPage, projectPage] = await Promise.all([users.list(), projects.list()])
      setItems(userPage.items)
      setProjectItems(projectPage.items)
    } catch (e) { setError(mensagemDeErro(e)) } finally { setLoading(false) }
  }, [projects, users])

  useEffect(() => { void load() }, [load])

  const openCreate = () => { setEditing(null); setForm(FORM_VAZIO); setError(null); setFormOpen(true) }
  const openEdit = (item: GlobalUser) => {
    setEditing(item); setError(null); setForm({ nome: item.nome, username: item.username ?? "", email: item.email ?? "", telefone: item.telefone ?? "", cpf: item.cpf ?? "", senhaInicial: "", ativo: item.ativo }); setFormOpen(true)
  }

  const saveUser = async () => {
    if (!users || !form.nome.trim() || (!editing && form.senhaInicial.length < 8)) return
    setSaving(true); setError(null)
    const input = { nome: form.nome.trim(), username: form.username || undefined, email: form.email || undefined, telefone: form.telefone || undefined, cpf: form.cpf || undefined, senhaInicial: form.senhaInicial || undefined, ativo: form.ativo }
    try {
      if (editing) await users.update(editing.id, input)
      else await users.create({ ...input, senhaInicial: form.senhaInicial })
      setFormOpen(false); await load()
    } catch (e) { setError(mensagemDeErro(e)) } finally { setSaving(false) }
  }

  const openDetail = async (item: GlobalUser) => {
    if (!users) return
    setDetailLoading(true); setError(null)
    try { setDetail(await users.get(item.id)) } catch (e) { setError(mensagemDeErro(e)) } finally { setDetailLoading(false) }
  }

  const deactivate = async (item: GlobalUser) => {
    if (!users || !window.confirm(`Desativar a conta de ${item.nome}?`)) return
    setError(null)
    try { await users.deactivate(item.id); await load(); if (detail?.id === item.id) setDetail(null) } catch (e) { setError(mensagemDeErro(e)) }
  }

  const linkedIds = new Set(detail?.vinculos.map((link) => link.projetoId) ?? [])
  const availableProjects = projectItems.filter((project) => !linkedIds.has(project.id) && project.ativo)

  const addLink = async () => {
    if (!users || !detail || !linkProject || !linkProfile) return
    setLinkSaving(true); setError(null)
    try { await users.updateLinks(detail.id, { adicionar: [{ projetoId: Number(linkProject), perfil: linkProfile }] }); setLinkProject(""); setLinkProfile(""); setDetail(await users.get(detail.id)) } catch (e) { setError(mensagemDeErro(e)) } finally { setLinkSaving(false) }
  }

  const changeLinkProfile = async (link: GlobalUserLink, perfil: Perfil) => {
    if (!users || !detail) return
    setLinkSaving(true); setError(null)
    try { await users.updateLinks(detail.id, { adicionar: [{ projetoId: link.projetoId, perfil }] }); setDetail(await users.get(detail.id)) } catch (e) { setError(mensagemDeErro(e)) } finally { setLinkSaving(false) }
  }

  const removeLink = async (link: GlobalUserLink) => {
    if (!users || !detail) return
    setLinkSaving(true); setError(null)
    try { await users.updateLinks(detail.id, { remover: [link.projetoId] }); setDetail(await users.get(detail.id)) } catch (e) { setError(mensagemDeErro(e)) } finally { setLinkSaving(false) }
  }

  return (
    <Stack spacing={2} data-testid="global-users-screen">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <div><Typography variant="h5">Usuários Gerais</Typography><Typography color="text.secondary">Contas globais e vínculos com projetos</Typography></div>
        <Stack direction="row" spacing={1}><Button startIcon={<RefreshRounded />} onClick={() => void load()}>Atualizar</Button><Button variant="contained" startIcon={<AddRounded />} onClick={openCreate}>Novo usuário</Button></Stack>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      <Paper variant="outlined">
        {loading ? <Stack alignItems="center" p={5}><CircularProgress /></Stack> : <Table>
          <TableHead><TableRow><TableCell>Nome</TableCell><TableCell>Usuário</TableCell><TableCell>E-mail</TableCell><TableCell>Status</TableCell><TableCell align="right">Ações</TableCell></TableRow></TableHead>
          <TableBody>{items.map((item) => <TableRow key={item.id} hover>
            <TableCell>{item.nome}</TableCell><TableCell>{item.username ?? "—"}</TableCell><TableCell>{item.email ?? "—"}</TableCell><TableCell>{item.ativo ? "Ativo" : "Desativado"}</TableCell>
            <TableCell align="right"><Button size="small" startIcon={<LinkRounded />} onClick={() => void openDetail(item)}>Vínculos</Button><Button size="small" startIcon={<EditRounded />} onClick={() => openEdit(item)}>Editar</Button>{item.ativo && <Button size="small" color="error" startIcon={<DeleteOutlineRounded />} onClick={() => void deactivate(item)}>Desativar</Button>}</TableCell>
          </TableRow>)}{items.length === 0 && <TableRow><TableCell colSpan={5} align="center">Nenhum usuário global encontrado.</TableCell></TableRow>}</TableBody>
        </Table>}
      </Paper>

      <Dialog open={formOpen} onClose={() => !saving && setFormOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editing ? "Editar usuário global" : "Novo usuário global"}</DialogTitle><DialogContent><Stack spacing={2} pt={1}>
          <TextField label="Nome" required value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
          <TextField label="Usuário" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <TextField label="E-mail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <TextField label="Telefone" value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} /><TextField label="CPF" value={form.cpf} onChange={(e) => setForm({ ...form, cpf: e.target.value })} />
          <TextField label={editing ? "Nova senha (opcional)" : "Senha inicial"} type="password" required={!editing} helperText={!editing ? "Mínimo de 8 caracteres" : "Deixe em branco para manter"} value={form.senhaInicial} onChange={(e) => setForm({ ...form, senhaInicial: e.target.value })} />
          <FormControlLabel control={<Checkbox checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />} label="Conta ativa" />
        </Stack></DialogContent><DialogActions><Button onClick={() => setFormOpen(false)}>Cancelar</Button><Button variant="contained" onClick={() => void saveUser()} disabled={saving || !form.nome.trim() || (!editing && form.senhaInicial.length < 8)}>{saving ? "Salvando…" : "Salvar"}</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="md">
        <DialogTitle>{detail ? `Vínculos de ${detail.nome}` : "Vínculos"}</DialogTitle><DialogContent><Stack spacing={2} pt={1}>
          {detailLoading && <CircularProgress size={22} />}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="stretch">
            <FormControl fullWidth required><InputLabel>Projeto</InputLabel><Select label="Projeto" value={linkProject} onChange={(e) => setLinkProject(e.target.value)}><MenuItem value=""><em>Selecione</em></MenuItem>{availableProjects.map((project) => <MenuItem key={project.id} value={project.id}>{projetoLabel(project)}</MenuItem>)}</Select></FormControl>
            <FormControl fullWidth required><InputLabel>Perfil</InputLabel><Select label="Perfil" value={linkProfile} onChange={(e) => setLinkProfile(e.target.value as Perfil)}><MenuItem value=""><em>Selecione</em></MenuItem>{PERFIS.map((perfil) => <MenuItem key={perfil.value} value={perfil.value}>{perfil.label}</MenuItem>)}</Select></FormControl>
            <Button variant="contained" onClick={() => void addLink()} disabled={linkSaving || !linkProject || !linkProfile}>Vincular</Button>
          </Stack>
          <Table size="small"><TableHead><TableRow><TableCell>Projeto</TableCell><TableCell>Perfil</TableCell><TableCell align="right">Ação</TableCell></TableRow></TableHead><TableBody>{detail?.vinculos.map((link) => <TableRow key={link.projetoId}><TableCell>{link.projetoNome}</TableCell><TableCell><Select size="small" value={link.perfil} onChange={(e) => void changeLinkProfile(link, e.target.value as Perfil)} disabled={linkSaving}>{PERFIS.map((perfil) => <MenuItem key={perfil.value} value={perfil.value}>{perfil.label}</MenuItem>)}</Select></TableCell><TableCell align="right"><Button color="error" size="small" onClick={() => void removeLink(link)} disabled={linkSaving}>Remover</Button></TableCell></TableRow>)}{detail?.vinculos.length === 0 && <TableRow><TableCell colSpan={3}>Nenhum vínculo.</TableCell></TableRow>}</TableBody></Table>
        </Stack></DialogContent><DialogActions><Button onClick={() => setDetail(null)}>Fechar</Button></DialogActions>
      </Dialog>
    </Stack>
  )
}
