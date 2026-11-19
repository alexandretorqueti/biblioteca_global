import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import { Box, CssBaseline, ThemeProvider, createTheme } from "@mui/material"
import { AgentChat } from "@biblioteca-global/ui"
import { ApiHttpClient, createAgentChatClient } from "@biblioteca-global/api-client"
import { alphaTenant, resolveTenant, tenants } from "./tenants"
import type { TenantConfig, TenantSlug } from "./tenants/types"
import "./IsaChat.css"
import "./AlphaChat.css"

const API_BASE_URL = import.meta.env.VITE_API_URL || "https://biblioteca-api.webconnect.com.br"
const ACCEPTED_FILE_TYPES = ".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.zip"
const STATE_LABEL: Record<string, string> = {
  novo: "Iniciando conversa",
  conversando: "Conversando",
  aguardando_codigo: "Verificação de e-mail",
  autenticado: "Conectado",
  finalizado: "Conversa finalizada",
}

type Metadata = {
  project?: { name?: string | null; definitions?: Array<{ id?: string; definition?: string }> }
  onboarding?: { state?: string; verified?: boolean; name?: string | null; email?: string | null }
}

export function getVisitorKey(storageKey: string): string {
  const current = window.localStorage.getItem(storageKey)
  if (current) return current
  const generated = `visitor-${safeUuid()}`
  window.localStorage.setItem(storageKey, generated)
  return generated
}

function safeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function metadata(value: Record<string, unknown> | undefined): Metadata {
  return (value ?? {}) as Metadata
}

function TenantSidebar({ tenant, data, onLogout }: { tenant: TenantConfig; data: Metadata; onLogout: () => void }): ReactNode {
  const prefix = tenant.slug
  const project = data.project
  const onboarding = data.onboarding
  const definitions = Array.isArray(project?.definitions) ? project.definitions : []
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [panelName, setPanelName] = useState(onboarding?.name || "")
  const [panelPhoto, setPanelPhoto] = useState<string | null>(null)
  const isAuthed = Boolean(onboarding?.verified)
  const stateLabel = onboarding ? STATE_LABEL[onboarding.state ?? ""] ?? onboarding.state : null

  const handlePhotoUpload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPanelPhoto(String(reader.result || ""))
    reader.readAsDataURL(file)
  }, [])
  const commitName = useCallback(() => {
    const name = nameDraft.trim()
    if (name) setPanelName(name)
    setEditingName(false)
  }, [nameDraft])
  const startEditName = useCallback(() => {
    setNameDraft(panelName)
    setEditingName(true)
  }, [panelName])

  if (!isAuthed) return null
  const isAlpha = tenant.slug === "alpha"
  const classes = {
    side: `${prefix}-side`, title: `${prefix}-side-title`, profile: `${prefix}-side-profile`,
    avatar: `${prefix}-avatar-btn`, camera: `${prefix}-avatar-cam`, block: `${prefix}-side-block`,
    label: `${prefix}-side-label`, value: `${prefix}-side-value`, name: `${prefix}-side-name`,
    edit: `${prefix}-name-edit`, button: `${prefix}-mini-btn`, ok: `${prefix}-mini-btn-ok`,
    logout: `${prefix}-logout-mini`, note: `${prefix}-mail-note`, summary: `${prefix}-side-summary-block`,
    defs: `${prefix}-side-definitions`, definition: `${prefix}-side-definition`, status: `${prefix}-side-status`,
    badge: `${prefix}-badge`, placeholder: `${prefix}-placeholder`, pencil: `${prefix}-edit-pencil`,
  }
  return (
    <aside className={classes.side}>
      <div className={classes.title}>{tenant.sidebarTitle}</div>
      <div className={classes.profile}>
        <label className={classes.avatar} title="Clique para enviar sua foto">
          {panelPhoto ? <img src={panelPhoto} alt="Sua foto" /> : <span>{(panelName || "?")[0].toUpperCase()}</span>}
          <span className={classes.camera}>📷</span>
          <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: "none" }} />
        </label>
        <div className={classes.block} style={isAlpha ? { flex: 1 } : undefined}>
          <div className={classes.label}>Cliente</div>
          {editingName ? (
            <div className={classes.edit}>
              <input autoFocus type="text" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitName(); if (event.key === "Escape") setEditingName(false) }} />
              <button type="button" className={`${classes.button} ${classes.ok}`} onClick={commitName} title="Salvar">✓</button>
              <button type="button" className={classes.button} onClick={() => setEditingName(false)} title="Cancelar">✕</button>
            </div>
          ) : (
            <div className={classes.name} onClick={() => panelName && startEditName()} title={panelName ? "Clique para editar o nome" : ""}>
              <span className={classes.value}>{panelName || "—"}</span>{panelName && <span className={classes.pencil}>✏️</span>}
            </div>
          )}
          <div className={classes.label} style={isAlpha ? { marginTop: "0.75rem" } : undefined}>E-mail</div>
          <div className={classes.value}>{onboarding?.email || "—"}</div>
          <em className={classes.note}>E-mail não pode ser alterado (identifica sua sessão).</em>
        </div>
        <button type="button" className={classes.logout} onClick={onLogout} title="Fechar sessão">Sair</button>
      </div>
      <div className={classes.block}><div className={classes.label}>Nome do projeto</div><div className={`${classes.value} ${classes.placeholder}`}>{project?.name || "A definir"}</div></div>
      <div className={`${classes.block} ${classes.summary}`}>
        <div className={classes.label}>Definições</div>
        {definitions.length > 0 ? <ol className={classes.defs}>{definitions.map((definition) => <li key={definition.id} className={classes.definition}>{definition.definition}</li>)}</ol> : <div className={`${classes.value} ${classes.placeholder}`}>As definições confirmadas do seu sistema vão aparecer aqui conforme a conversa avança.</div>}
      </div>
      {stateLabel && <div className={classes.status}><span className={classes.badge}>{stateLabel}</span></div>}
    </aside>
  )
}

function updateHead(tenant: TenantConfig): void {
  document.title = tenant.title
  let description = document.querySelector('meta[name="description"]')
  if (!description) { description = document.createElement("meta"); description.setAttribute("name", "description"); document.head.appendChild(description) }
  description.setAttribute("content", tenant.description)
  let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (tenant.avatar) {
    if (!favicon) { favicon = document.createElement("link"); favicon.rel = "icon"; document.head.appendChild(favicon) }
    favicon.href = "/favicon.svg"
    favicon.type = "image/svg+xml"
  } else if (favicon) favicon.remove()
  if (tenant.slug === "alpha" && !document.querySelector('link[data-chat-fonts="alpha"]')) {
    const fonts = document.createElement("link")
    fonts.rel = "stylesheet"
    fonts.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lato:wght@300;400;500;600;700&display=swap"
    fonts.dataset.chatFonts = "alpha"
    document.head.appendChild(fonts)
  }
}

export function applyTenantScope(slug: TenantSlug): () => void {
  const isAlpha = slug === "alpha"
  document.documentElement.classList.toggle("tenant-alpha", isAlpha)
  document.body.classList.toggle("tenant-alpha", isAlpha)
  return () => {
    document.documentElement.classList.remove("tenant-alpha")
    document.body.classList.remove("tenant-alpha")
  }
}

export function App() {
  const queryTenant = new URLSearchParams(window.location.search).get("tenant")
  const slug = resolveTenant(window.location.hostname, queryTenant)
  if (!slug) return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "sans-serif", color: "#243447" }}>Atendimento indisponível.</main>
  return <TenantApp slug={slug} />
}

function TenantApp({ slug }: { slug: TenantSlug }) {
  const tenant = tenants[slug]
  const visitorKey = useMemo(() => getVisitorKey(tenant.storage.chatId), [tenant.storage.chatId])
  const [rawMetadata, setRawMetadata] = useState<Record<string, unknown> | undefined>()
  const data = metadata(rawMetadata)
  const isAuthed = Boolean(data.onboarding?.verified)

  useEffect(() => { updateHead(tenant) }, [tenant])
  useEffect(() => applyTenantScope(slug), [slug])
  const theme = useMemo(() => createTheme({ palette: { mode: "light", primary: { main: tenant.primary }, secondary: { main: tenant.secondary }, ...(slug === "isa" ? { background: { default: "#f5f7fa", paper: "#ffffff" }, text: { primary: "#243447", secondary: "#5f6f82" } } : {}) }, typography: { fontFamily: tenant.fontFamily } }), [slug, tenant])
  const http = useMemo(() => new ApiHttpClient({ baseUrl: API_BASE_URL, tokens: { getAccessToken: () => null, getRefreshToken: () => null, setAccessToken: () => {}, setRefreshToken: () => {} } }), [])
  const client = useMemo(() => {
    const baseClient = createAgentChatClient({ http, agentId: tenant.agent.id, visitorKey, endpoints: {
      sessionPath: "/api/session", sendPath: "/api/chat/send", historyPath: (chatId) => `/api/chat/${encodeURIComponent(chatId)}/history`, visitPath: "/api/site-visit",
      buildSessionBody: ({ visitorKey: key }) => tenant.buildSessionBody(key),
      buildSendBody: ({ chatId, text, attachments }) => tenant.buildSendBody({ chatId, text, attachments }),
      historyMetadata: (response) => { const result: Record<string, unknown> = {}; if (response.project && typeof response.project === "object") result.project = response.project; if (response.onboarding && typeof response.onboarding === "object") result.onboarding = response.onboarding; return Object.keys(result).length ? result : undefined },
    } })
    return { ...baseClient, loadHistory: async () => { const history = await baseClient.loadHistory(); setRawMetadata(history.metadata); return history } }
  }, [http, tenant, visitorKey])
  const handleLogout = useCallback(() => { try { window.localStorage.removeItem(tenant.storage.chatId); window.localStorage.removeItem(tenant.storage.loginEmail) } catch { /* storage unavailable */ } window.location.reload() }, [tenant])
  const pageClass = slug === "isa" ? "isa-page" : "alpha-page"
  return <ThemeProvider theme={theme}><CssBaseline /><div className={pageClass}>
    {slug === "isa" ? <><header className="isa-site-header"><div className="isa-brand" aria-label="Global Tecnologia"><span className="isa-brand-mark" aria-hidden="true">G</span><span>GLOBAL <strong>TECNOLOGIA</strong></span></div><span className="isa-header-label">Assistente virtual</span></header><main className="isa-page-main"><section className="isa-intro" aria-labelledby="isa-title"><span className="isa-eyebrow">Transformação digital</span><h1 id="isa-title">Como podemos apoiar sua operação?</h1><p>Converse com a Isa sobre desenvolvimento, sustentação e modernização de sistemas.</p></section><Box className={`isa-layout ${isAuthed ? "isa-authed" : ""}`}><Box className="isa-chat-container"><AgentChat agent={tenant.agent} client={client} welcomeMessage={tenant.welcomeMessage} placeholder={tenant.placeholder} historyRefreshIntervalMs={5_000} allowAttachments acceptedFileTypes={ACCEPTED_FILE_TYPES} renderSidebar={() => <TenantSidebar tenant={tenant} data={data} onLogout={handleLogout} />} /></Box>{isAuthed && <TenantSidebar tenant={tenant} data={data} onLogout={handleLogout} />}</Box></main><footer className="isa-site-footer">© 2026 Global Tecnologia · Soluções corporativas em TI</footer></> : <><header className="alpha-header"><div className="alpha-header-content"><img src={alphaTenant.avatar} alt="Alpha" className="alpha-logo" /><div className="alpha-header-text"><h1>Alpha</h1><p className="alpha-header-tagline">Plataforma Inteligente de Atendimento e Serviços ao Morador</p><p className="alpha-header-subtitle">Assistente virtual — Alphaville Rio Costa do Sol</p></div></div><div className="alpha-header-badge">Alto Padrão</div></header><main className="alpha-main"><div className={`alpha-layout ${isAuthed ? "alpha-authed" : ""}`}><div className="alpha-chat-container"><AgentChat agent={tenant.agent} client={client} welcomeMessage={tenant.welcomeMessage} placeholder={tenant.placeholder} historyRefreshIntervalMs={5_000} allowAttachments acceptedFileTypes={ACCEPTED_FILE_TYPES} renderSidebar={() => <TenantSidebar tenant={tenant} data={data} onLogout={handleLogout} />} /></div>{isAuthed && <TenantSidebar tenant={tenant} data={data} onLogout={handleLogout} />}</div></main><footer className="alpha-footer"><div className="alpha-footer-content"><p>© 2026 Alphaville Rio Costa do Sol. Todos os direitos reservados.</p><p><a href="https://www.alphaville.com.br" target="_blank" rel="noopener noreferrer">www.alphaville.com.br</a></p><p className="alpha-footer-credit"><svg className="alpha-footer-logo" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>Desenvolvido por <a href="https://www.globaltecnologia.net" target="_blank" rel="noopener noreferrer">Global Tecnologia</a></p></div></footer></>}
  </div></ThemeProvider>
}
