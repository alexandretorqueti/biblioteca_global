import { useMemo, useState, useCallback, type ReactNode } from "react"
import { ThemeProvider, createTheme, CssBaseline, Box } from "@mui/material"
import { AgentChat } from "@biblioteca-global/ui"
import { createAgentChatClient, ApiHttpClient } from "@biblioteca-global/api-client"
import "./AlphaChat.css"

const API_BASE_URL = import.meta.env.VITE_API_URL || "https://biblioteca-api.webconnect.com.br"
const alphaAvatar = `${import.meta.env.BASE_URL}alpha-avatar.png`

function getVisitorKey(): string {
  const storageKey = "alpha.chatId"
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

type AlphaMetadata = {
  project?: { name?: string | null; definitions?: Array<{ id?: string; definition?: string }> }
  onboarding?: { state?: string; verified?: boolean; name?: string | null; email?: string | null }
}

function alphaMetadata(value: Record<string, unknown> | undefined): AlphaMetadata {
  return (value ?? {}) as AlphaMetadata
}

const STATE_LABEL: Record<string, string> = {
  novo: "Iniciando conversa",
  conversando: "Conversando",
  aguardando_codigo: "Verificação de e-mail",
  autenticado: "Conectado",
  finalizado: "Conversa finalizada",
}

function AlphaSidebar({
  metadata,
  onLogout,
}: {
  metadata?: Record<string, unknown>
  onLogout: () => void
}): ReactNode {
  const data = alphaMetadata(metadata)
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
    <aside className="alpha-side">
      <div className="alpha-side-title">Seu Projeto</div>

      <div className="alpha-side-profile">
        <label className="alpha-avatar-btn" title="Clique para enviar sua foto">
          {panelPhoto ? (
            <img src={panelPhoto} alt="Sua foto" />
          ) : (
            <span>{(panelName || "?")[0].toUpperCase()}</span>
          )}
          <span className="alpha-avatar-cam">📷</span>
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoUpload}
            style={{ display: "none" }}
          />
        </label>

        <div className="alpha-side-block" style={{ flex: 1 }}>
          <div className="alpha-side-label">Cliente</div>
          {editingName ? (
            <div className="alpha-name-edit">
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
              <button type="button" className="alpha-mini-btn alpha-mini-btn-ok" onClick={commitName} title="Salvar">
                ✓
              </button>
              <button type="button" className="alpha-mini-btn" onClick={() => setEditingName(false)} title="Cancelar">
                ✕
              </button>
            </div>
          ) : (
            <div
              className="alpha-side-name"
              onClick={() => panelName && startEditName()}
              title={panelName ? "Clique para editar o nome" : ""}
            >
              <span className="alpha-side-value">{panelName || "—"}</span>
              {panelName && <span className="alpha-edit-pencil">✏️</span>}
            </div>
          )}
          <div className="alpha-side-label" style={{ marginTop: "0.75rem" }}>E-mail</div>
          <div className="alpha-side-value">{onboarding?.email || "—"}</div>
          <em className="alpha-mail-note">E-mail não pode ser alterado (identifica sua sessão).</em>
        </div>

        <button type="button" className="alpha-logout-mini" onClick={onLogout} title="Fechar sessão">
          Sair
        </button>
      </div>

      <div className="alpha-side-block">
        <div className="alpha-side-label">Nome do projeto</div>
        <div className="alpha-side-value alpha-placeholder">{project?.name || "A definir"}</div>
      </div>

      <div className="alpha-side-block alpha-side-summary-block">
        <div className="alpha-side-label">Definições</div>
        {definitions.length > 0 ? (
          <ol className="alpha-side-definitions">
            {definitions.map((d) => (
              <li key={d.id} className="alpha-side-definition">
                {d.definition}
              </li>
            ))}
          </ol>
        ) : (
          <div className="alpha-side-value alpha-placeholder">
            As definições confirmadas do seu sistema vão aparecer aqui conforme a conversa avança.
          </div>
        )}
      </div>

      {stateLabel && (
        <div className="alpha-side-status">
          <span className={`alpha-badge ${isAuthed ? "" : "alpha-badge-onboarding"}`}>{stateLabel}</span>
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
      mode: 'light',
      primary: {
        main: '#1a3a5c',
      },
      secondary: {
        main: '#c9a961',
      },
    },
    typography: {
      fontFamily: '"Lato", "Helvetica", "Arial", sans-serif',
    },
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
      agentId: "alpha",
      visitorKey,
      endpoints: {
        sessionPath: "/api/session",
        sendPath: "/api/chat/send",
        historyPath: (chatId) => `/api/chat/${encodeURIComponent(chatId)}/history`,
        visitPath: "/api/site-visit",
        buildSessionBody: ({ visitorKey: key }) => ({ chatKey: key, agentId: "alpha" }),
        buildSendBody: ({ chatId, text, attachments }) => ({
          chatId,
          text,
          agentId: "alpha",
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
      window.localStorage.removeItem("alpha.chatId")
      window.localStorage.removeItem("alpha.loginEmail")
    } catch {
      /* localStorage indisponível */
    }
    window.location.reload()
  }, [])

  const onboarding = alphaMetadata(metadata).onboarding
  const isAuthed = Boolean(onboarding?.verified)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      {/* Header Alphaville */}
      <header className="alpha-header">
        <div className="alpha-header-content">
          <img src={alphaAvatar} alt="Alpha" className="alpha-logo" />
          <div className="alpha-header-text">
            <h1>Alpha</h1>
            <p className="alpha-header-tagline">Plataforma Inteligente de Atendimento e Serviços ao Morador</p>
            <p className="alpha-header-subtitle">Assistente virtual — Alphaville Rio Costa do Sol</p>
          </div>
        </div>
        <div className="alpha-header-badge">Alto Padrão</div>
      </header>

      {/* Conteúdo principal */}
      <main className="alpha-main">
        <div className={`alpha-layout ${isAuthed ? "alpha-authed" : ""}`}>
          <div className="alpha-chat-container">
            <AgentChat
              agent={{ id: "alpha", name: "Alpha", domain: "alpha.globaltecnologia.net" }}
              client={client}
              welcomeMessage="Olá! 👋 Sou a Alpha, assistente virtual do Alphaville Rio Costa do Sol. Estou aqui para ajudar você a descobrir o empreendimento ideal para seu perfil, apresentar nossos projetos de alto padrão e tirar todas as suas dúvidas sobre segurança, lazer e qualidade de vida. Como posso ajudar você hoje?"
              placeholder="Digite sua mensagem..."
              historyRefreshIntervalMs={5_000}
              allowAttachments
              acceptedFileTypes=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.zip"
              renderSidebar={() => <AlphaSidebar metadata={metadata} onLogout={handleLogout} />}
            />
          </div>
        </div>
      </main>

      {/* Footer Alphaville */}
      <footer className="alpha-footer">
        <div className="alpha-footer-content">
          <p>© 2026 Alphaville Rio Costa do Sol. Todos os direitos reservados.</p>
          <p>
            <a href="https://www.alphaville.com.br" target="_blank" rel="noopener noreferrer">
              www.alphaville.com.br
            </a>
          </p>
          <p className="alpha-footer-credit">
            <svg className="alpha-footer-logo" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            Desenvolvido por <a href="https://www.globaltecnologia.net" target="_blank" rel="noopener noreferrer">Global Tecnologia</a>
          </p>
        </div>
      </footer>
    </ThemeProvider>
  )
}
