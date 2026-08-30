import { useMemo, useState, useCallback, type ReactNode } from "react"
import { ThemeProvider, createTheme, CssBaseline, Box } from "@mui/material"
import { AgentChat } from "@biblioteca-global/ui"
import { createAgentChatClient, ApiHttpClient } from "@biblioteca-global/api-client"
import "./IsaChat.css"

// URL da API (túnel Cloudflare)
const API_BASE_URL = import.meta.env.VITE_API_URL || "https://biblioteca-api.webconnect.com.br"

function getVisitorKey(): string {
  const storageKey = "isa.chatId"
  const current = window.localStorage.getItem(storageKey)
  if (current) return current
  const generated = `visitor-${safeUuid()}`
  window.localStorage.setItem(storageKey, generated)
  return generated
}

function safeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type IsaMetadata = {
  project?: { name?: string | null; definitions?: Array<{ id?: string; definition?: string }> }
  onboarding?: { state?: string; verified?: boolean; name?: string | null; email?: string | null }
}

function isaMetadata(value: Record<string, unknown> | undefined): IsaMetadata {
  return (value ?? {}) as IsaMetadata
}

const STATE_LABEL: Record<string, string> = {
  novo: "Iniciando conversa",
  conversando: "Conversando",
  aguardando_codigo: "Verificação de e-mail",
  autenticado: "Conectado",
  finalizado: "Conversa finalizada",
}

function IsaSidebar({
  metadata,
  onLogout,
}: {
  metadata?: Record<string, unknown>
  onLogout: () => void
}): ReactNode {
  const data = isaMetadata(metadata)
  const project = data.project
  const onboarding = data.onboarding
  const definitions = Array.isArray(project?.definitions) ? project.definitions : []

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [panelName, setPanelName] = useState(onboarding?.name || "")
  const [panelPhoto, setPanelPhoto] = useState<string | null>(null)

  const isAuthed = Boolean(onboarding?.verified)
  const stateLabel = onboarding ? STATE_LABEL[onboarding.state] ?? onboarding.state : null

  const handlePhotoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setPanelPhoto(String(reader.result || ""))
    }
    reader.readAsDataURL(file)
  }, [])

  const startEditName = useCallback(() => {
    setNameDraft(panelName)
    setEditingName(true)
  }, [panelName])

  const commitName = useCallback(() => {
    const nm = nameDraft.trim()
    if (nm) setPanelName(nm)
    setEditingName(false)
  }, [nameDraft])

  if (!isAuthed) return null

  return (
    <aside className="isa-side">
      <div className="isa-side-title">Projeto</div>

      <div className="isa-side-profile">
        <label className="isa-avatar-btn" title="Clique para enviar sua foto">
          {panelPhoto ? (
            <img src={panelPhoto} alt="Sua foto" />
          ) : (
            <span>{(panelName || "?")[0].toUpperCase()}</span>
          )}
          <span className="isa-avatar-cam">📷</span>
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoUpload}
            style={{ display: "none" }}
          />
        </label>

        <div className="isa-side-block isa-side-grow">
          <div className="isa-side-label">Cliente</div>
          {editingName ? (
            <div className="isa-name-edit">
              <input
                autoFocus
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName()
                  if (e.key === "Escape") setEditingName(false)
                }}
              />
              <button type="button" className="isa-mini-btn isa-mini-btn-ok" onClick={commitName} title="Salvar">
                ✓
              </button>
              <button type="button" className="isa-mini-btn" onClick={() => setEditingName(false)} title="Cancelar">
                ✕
              </button>
            </div>
          ) : (
            <div
              className="isa-side-name"
              onClick={() => panelName && startEditName()}
              title={panelName ? "Clique para editar o nome" : ""}
            >
              <span className="isa-side-value">{panelName || "—"}</span>
              {panelName && <span className="isa-edit-pencil">✏️</span>}
            </div>
          )}
          <div className="isa-side-label">E-mail</div>
          <div className="isa-side-value">{onboarding?.email || "—"}</div>
          <em className="isa-mail-note">E-mail não pode ser alterado (identifica sua sessão).</em>
        </div>

        <button type="button" className="isa-logout-mini" onClick={onLogout} title="Fechar sessão">
          Sair
        </button>
      </div>

      <div className="isa-side-block">
        <div className="isa-side-label">Nome do projeto</div>
        <div className="isa-side-value isa-placeholder">{project?.name || "A definir"}</div>
      </div>

      <div className="isa-side-block isa-side-summary-block">
        <div className="isa-side-label">Definições</div>
        {definitions.length > 0 ? (
          <ol className="isa-side-definitions">
            {definitions.map((d) => (
              <li key={d.id} className="isa-side-definition">
                {d.definition}
              </li>
            ))}
          </ol>
        ) : (
          <div className="isa-side-value isa-placeholder">
            As definições confirmadas do seu sistema vão aparecer aqui conforme a conversa avança.
          </div>
        )}
      </div>

      {stateLabel && (
        <div className="isa-side-status">
          <span className={`isa-badge ${isAuthed ? "" : "isa-badge-onboarding"}`}>{stateLabel}</span>
        </div>
      )}
    </aside>
  )
}

export function App() {
  const visitorKey = useMemo(() => getVisitorKey(), [])
  const [metadata, setMetadata] = useState<Record<string, unknown> | undefined>()

  const theme = useMemo(() => createTheme({
    palette: {
      mode: "light",
      primary: { main: "#003366", dark: "#00264d", contrastText: "#ffffff" },
      secondary: { main: "#2e8bc0" },
      background: { default: "#f5f7fa", paper: "#ffffff" },
      text: { primary: "#243447", secondary: "#5f6f82" },
    },
    typography: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  }), [])

  const http = useMemo(
    () =>
      new ApiHttpClient({
        baseUrl: API_BASE_URL,
        tokens: {
          getAccessToken: () => null,
          getRefreshToken: () => null,
          setAccessToken: () => {},
          setRefreshToken: () => {},
        },
      }),
    [],
  )

  const client = useMemo(() => {
    const baseClient = createAgentChatClient({
      http,
      agentId: "isa",
      visitorKey,
      endpoints: {
        sessionPath: "/api/session",
        sendPath: "/api/chat/send",
        historyPath: (chatId) => `/api/chat/${encodeURIComponent(chatId)}/history`,
        visitPath: "/api/site-visit",
        buildSessionBody: ({ visitorKey: key }) => ({ chatKey: key }),
        buildSendBody: ({ chatId, text, attachments }) => ({
          chatId,
          text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
        historyMetadata: (data) => {
          const meta: Record<string, unknown> = {}
          if (data.project && typeof data.project === "object") meta.project = data.project
          if (data.onboarding && typeof data.onboarding === "object") meta.onboarding = data.onboarding
          return Object.keys(meta).length > 0 ? meta : undefined
        },
      },
    })

    // Sobrescreve loadHistory para capturar metadata
    return {
      ...baseClient,
      loadHistory: async () => {
        const history = await baseClient.loadHistory()
        setMetadata(history.metadata)
        return history
      },
    }
  }, [http, visitorKey])

  const handleLogout = useCallback(() => {
    try {
      window.localStorage.removeItem("isa.chatId")
      window.localStorage.removeItem("isa.loginEmail")
    } catch {
      /* localStorage indisponível */
    }
    window.location.reload()
  }, [])

  const onboarding = isaMetadata(metadata).onboarding
  const isAuthed = Boolean(onboarding?.verified)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="isa-page">
        <header className="isa-site-header">
          <div className="isa-brand" aria-label="Global Tecnologia">
            <span className="isa-brand-mark" aria-hidden="true">G</span>
            <span>GLOBAL <strong>TECNOLOGIA</strong></span>
          </div>
          <span className="isa-header-label">Assistente virtual</span>
        </header>

        <main className="isa-page-main">
          <section className="isa-intro" aria-labelledby="isa-title">
            <span className="isa-eyebrow">Transformação digital</span>
            <h1 id="isa-title">Como podemos apoiar sua operação?</h1>
            <p>Converse com a Isa sobre desenvolvimento, sustentação e modernização de sistemas.</p>
          </section>

          <Box className={`isa-layout ${isAuthed ? "isa-authed" : ""}`}>
            <Box className="isa-chat-container">
              <AgentChat
                agent={{ id: "isa", name: "Isa", domain: "isa.globaltecnologia.net" }}
                client={client}
                welcomeMessage="Olá! 👋 Sou a Isa, da Global Tecnologia. Envie sua mensagem para eu te ajudar a construir o sistema que você precisa."
                placeholder="Digite sua mensagem..."
                allowAttachments
                acceptedFileTypes=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.zip"
                renderSidebar={() => <IsaSidebar metadata={metadata} onLogout={handleLogout} />}
              />
            </Box>
          </Box>
        </main>

        <footer className="isa-site-footer">© 2026 Global Tecnologia · Soluções corporativas em TI</footer>
      </div>
    </ThemeProvider>
  )
}
